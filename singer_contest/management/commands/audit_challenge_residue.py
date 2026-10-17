"""Find challenge-generated TEST rounds orphaned by an earlier cleanup bug.

Between ``54ff87d`` and ``6c8e93b``, ``clear_activity_test_data`` deleted the challenge
session and match rows but not the per-match scoring rounds they had generated. Those
rounds are ordinary ``ContestRound`` rows with no ``is_test_data`` column, so once their
``ChallengeMatch`` link is gone nothing in the current model can identify them by shape.
The audit trail can: ``CHALLENGE_SCORE_PREPARE`` records the generated ``score_round_id``,
and ``CHALLENGE_FINAL_ROUND_PREPARE`` records the R3 in its target.

The default run is read-only. ``--delete`` removes only DRAFT, unlocked rounds inside an
activity that is still in the TEST lifecycle, that no match, session or group stage still
links to, and that no ruleset editing or history surface claims. A round an operator
deliberately rebound is no longer residue; deleting it would leave a dangling formal
binding. One candidate refusing deletion never stops the others.
"""

from __future__ import annotations

import json
from collections import Counter

from common.authority import TEST_DATA_CLEANUP, authority_write
from common.models import AuditLog
from common.test_data import lock_activity_for_runtime_data
from django.core.exceptions import ValidationError
from django.core.management.base import BaseCommand, CommandParser
from django.db import transaction
from django.db.models.deletion import ProtectedError

from singer_contest.models import ChallengeMatch, ContestRound
from singer_contest.services import _round_is_claimed_by_a_binding


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


def _is_claimed_by_any_binding(contest_round: ContestRound) -> bool:
    """Whether any editing or history surface still names this round.

    A genuine old dynamic score round never appears in a ruleset binding. If one now does,
    an operator has deliberately reused it, and the repair command must not treat it as
    residue: deleting it would leave a dangling ``round_keys`` entry.
    """

    from ruleset.models import ContestRuleset

    return any(
        _round_is_claimed_by_a_binding(contest_round, ruleset)
        for ruleset in ContestRuleset.objects.filter(activity_id=contest_round.activity_id)
    )


def _classify(contest_round: ContestRound, *, activity) -> str:
    if not activity.is_test_mode or activity.data_lifecycle != activity.DataLifecycle.TEST:
        return "outside_test"
    if ChallengeMatch.objects.filter(score_round_id=contest_round.pk).exists():
        return "still_linked"
    if (
        contest_round.roster_source == ContestRound.RosterSource.CHALLENGE_SESSION
        and contest_round.roster_source_challenge_session_id
    ):
        # The final round still belongs to a live session; normal cleanup owns it.
        return "still_linked"
    if contest_round.group_stages_sourcing.exists():
        # A group stage PROTECTs its source round. Any surviving FK — DRAFT or not — means
        # this round has been reused; deciding whether that stage may let go is the stage
        # lifecycle's job, not this repair command's.
        return "still_linked"
    if _is_claimed_by_any_binding(contest_round):
        return "rebound"
    if contest_round.status != ContestRound.Status.DRAFT or contest_round.is_locked:
        return "not_removable"
    return "orphaned"


@transaction.atomic
def _delete_orphan_under_lock(round_id: int) -> str:
    """Re-validate and delete one candidate while holding the activity lock.

    The scan and the delete are separate moments. Locking the activity and re-reading the
    round closes the TOCTOU window against a concurrent rebind, cleanup, or
    ``leave_test_mode``. The locked activity instance is attached to the round so the
    model's own deletion guard sees the fresh lifecycle, not a stale cached relation.
    """

    initial = ContestRound._base_manager.select_related("activity").filter(pk=round_id).first()
    if initial is None:
        return "missing"
    locked_activity = lock_activity_for_runtime_data(initial.activity)
    contest_round = (
        ContestRound.objects.select_for_update()
        .select_related("activity")
        .filter(pk=round_id)
        .first()
    )
    if contest_round is None:
        return "missing"
    contest_round.activity = locked_activity
    outcome = _classify(contest_round, activity=locked_activity)
    if outcome != "orphaned":
        return outcome
    with authority_write(TEST_DATA_CLEANUP):
        contest_round.delete()
    return "deleted"


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

        counts: Counter[str] = Counter()
        orphaned: list[ContestRound] = []
        audited = 0
        for contest_round in candidates.order_by("pk"):
            audited += 1
            outcome = _classify(contest_round, activity=contest_round.activity)
            counts[outcome] += 1
            if outcome == "orphaned":
                orphaned.append(contest_round)

        self.stdout.write(f"audited={audited}")
        self.stdout.write(f"orphaned={counts['orphaned']}")
        self.stdout.write(f"still_linked={counts['still_linked']}")
        self.stdout.write(f"outside_test={counts['outside_test']}")
        self.stdout.write(f"rebound={counts['rebound']}")
        self.stdout.write(f"not_removable={counts['not_removable']}")
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
                outcome = _delete_orphan_under_lock(contest_round.pk)
            except (ValidationError, ProtectedError) as error:
                # A conservative refusal on one candidate must not stop the others. Each
                # candidate is its own transaction, so previous deletions stay committed.
                self.stderr.write(f"  skipped round={contest_round.pk} reason=protected: {error}")
                continue
            if outcome == "deleted":
                deleted += 1
            else:
                self.stderr.write(f"  skipped round={contest_round.pk} reason={outcome}")
        self.stdout.write(f"deleted={deleted}")
