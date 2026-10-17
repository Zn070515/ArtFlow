"""Find challenge-generated TEST rounds orphaned by an earlier cleanup bug.

Between ``54ff87d`` and ``6c8e93b``, ``clear_activity_test_data`` deleted the challenge
session and match rows but not the per-match scoring rounds they had generated. Those
rounds are ordinary ``ContestRound`` rows with no ``is_test_data`` column, so once their
``ChallengeMatch`` link is gone nothing in the current model can identify them by shape.
The audit trail can: ``CHALLENGE_SCORE_PREPARE`` records the generated ``score_round_id``,
and ``CHALLENGE_FINAL_ROUND_PREPARE`` records the R3 in its target.

The default run is read-only. ``--delete`` removes only DRAFT, unlocked rounds inside an
activity that is still in the TEST lifecycle; anything still linked to a match or a live
session is left to the normal cleanup lifecycle.
"""

from __future__ import annotations

import json

from common.authority import TEST_DATA_CLEANUP, authority_write
from common.models import AuditLog
from django.core.exceptions import ValidationError
from django.core.management.base import BaseCommand, CommandParser

from singer_contest.models import ChallengeMatch, ContestRound


def _audited_challenge_round_ids() -> set[int]:
    ids: set[int] = set()
    audits = AuditLog.objects.filter(
        action_type__in=[
            AuditLog.ActionType.CHALLENGE_SCORE_PREPARE,
            AuditLog.ActionType.CHALLENGE_FINAL_ROUND_PREPARE,
        ]
    ).only("action_type", "target", "new_value")
    for audit in audits:
        value: object
        if audit.action_type == AuditLog.ActionType.CHALLENGE_SCORE_PREPARE:
            try:
                payload = json.loads(audit.new_value or "{}")
            except (TypeError, ValueError):
                continue
            value = payload.get("score_round_id") if isinstance(payload, dict) else None
        else:
            value = audit.target.rsplit(":", 1)[-1]
        try:
            ids.add(int(value))  # type: ignore[arg-type]
        except (TypeError, ValueError):
            continue
    return ids


class Command(BaseCommand):
    help = (
        "Audit (and optionally delete) challenge-generated TEST rounds orphaned by the old cleanup."
    )

    def add_arguments(self, parser: CommandParser) -> None:
        parser.add_argument(
            "--delete",
            action="store_true",
            help="Delete the orphaned DRAFT rounds. Without it the command only reports.",
        )
        parser.add_argument(
            "--activity-id",
            type=int,
            default=None,
            help="Limit the audit to one activity.",
        )

    def handle(self, *args, **options) -> None:
        candidates = ContestRound.objects.filter(
            pk__in=_audited_challenge_round_ids()
        ).select_related("activity")
        if options["activity_id"] is not None:
            candidates = candidates.filter(activity_id=options["activity_id"])

        orphaned: list[ContestRound] = []
        still_linked = 0
        outside_test = 0
        not_removable = 0
        for contest_round in candidates.order_by("pk"):
            activity = contest_round.activity
            if not activity.is_test_mode or activity.data_lifecycle != activity.DataLifecycle.TEST:
                outside_test += 1
                continue
            if ChallengeMatch.objects.filter(score_round_id=contest_round.pk).exists():
                still_linked += 1
                continue
            if (
                contest_round.roster_source == ContestRound.RosterSource.CHALLENGE_SESSION
                and contest_round.roster_source_challenge_session_id
            ):
                # The final round still belongs to a live session; normal cleanup owns it.
                still_linked += 1
                continue
            if contest_round.status != ContestRound.Status.DRAFT or contest_round.is_locked:
                not_removable += 1
                continue
            orphaned.append(contest_round)

        self.stdout.write(f"audited={len(candidates)}")
        self.stdout.write(f"orphaned={len(orphaned)}")
        self.stdout.write(f"still_linked={still_linked}")
        self.stdout.write(f"outside_test={outside_test}")
        self.stdout.write(f"not_removable={not_removable}")
        for contest_round in orphaned:
            self.stdout.write(
                f"  orphan round={contest_round.pk} activity={contest_round.activity_id} "
                f"name={contest_round.name or contest_round.get_round_type_display()}"
            )

        if not options["delete"]:
            if orphaned:
                self.stdout.write("read-only run; pass --delete to remove these rounds")
            return

        deleted = 0
        for contest_round in orphaned:
            try:
                with authority_write(TEST_DATA_CLEANUP):
                    contest_round.delete()
            except ValidationError as error:
                self.stderr.write(f"  failed round={contest_round.pk}: {error}")
                continue
            deleted += 1
        self.stdout.write(f"deleted={deleted}")
