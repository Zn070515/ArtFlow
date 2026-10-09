"""Build the actor cast for the local site load simulation.

One formal singer-contest activity that behaves like the show: a roster in a prepared round
with a live performance, a five-seat judge panel, a frozen ruleset carrying the 2025
questionnaire, tickets in four states, and an open popularity vote.

The contest core mirrors `prepare_judge_e2e` — the same phases and the same service calls that
fixture already proves work — so the actors exercise the real flow rather than a bypass of it.
What this adds is scale, a formal lifecycle, and the audience side.

The manifest this writes is the only thing the runner reads. It carries **no access keys**: a
file holding both a username and its key is a ready-to-use credential bundle, so the keys come
from the runner's environment instead.
"""

from __future__ import annotations

import json
import os
from datetime import timedelta
from pathlib import Path
from typing import Any
from uuid import uuid4

from accounts.models import User
from core.models import Activity
from core.services import transition_activity_phase
from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from django.utils import timezone
from ruleset.models import ContestRuleset, RulesetVersion
from ruleset.services import create_ruleset_version, freeze_ruleset_version
from singer_contest.judge_authority import advance_performance, prepare_judge_panel
from singer_contest.judge_entry import judge_entry_credential
from singer_contest.models import (
    ContestRound,
    Performance,
    RoundPanelSnapshot,
    SingerRegistration,
)
from singer_contest.services import prepare_round, set_round_groups
from tickets.services import (
    check_in_ticket_outcome,
    create_ticket,
    issue_ticket,
    revoke_ticket,
    rotate_ticket_credential,
    ticket_credential,
)
from voting.models import VoteOption, VoteSession
from voting.services import close_vote_session, open_vote_session

from common.authority import (
    ACCOUNT_AUTHORITY,
    ACTIVITY_STATE,
    CONTEST_ROUND_STATE,
    RULESET_FREEZE,
    authority_write,
)
from common.private_test_questionnaire import historical_2025_questionnaire

# The cast, per docs/local-load-simulation-plan.md §3. The counts live here so the manifest and
# the actors cannot disagree about how many were built.
PERFORMER_COUNT = 12
JUDGE_COUNT = 5
STAFF_ROLES = ("judge-desk", "score-entry", "check-in", "audience-side", "backstage")
TICKET_COUNTS = {
    "valid_checked_in": 100,
    "valid_not_checked": 10,
    "revoked": 4,
    "stale_credential": 4,
}
ROUND_KEYS = ("r1", "r2", "r3", "r4")

# The smallest definition the compiler accepts with a questionnaire attached — the same shape
# the questionnaire upload tests freeze, so this uses a known-good freeze path rather than a new
# one that happens to work today.
DEFINITION = json.dumps(
    {
        "schema_version": 1,
        "nodes": [
            {"key": "assess_r1", "type": "ASSESS", "source": "entry", "round": "r1"},
            {"key": "rank1", "type": "RANK", "source": "assess_r1", "descending": True},
            {"key": "top3", "type": "SELECT", "source": "rank1", "count": 3},
        ],
    },
    ensure_ascii=False,
)


def _password(label: str) -> str:
    return f"{label}!{uuid4().hex[:12]}"


class Command(BaseCommand):
    help = "Build the formal actor cast for the local site load simulation."

    def add_arguments(self, parser: Any) -> None:
        parser.add_argument(
            "--output-file", required=True, help="Write the actor manifest to this private file."
        )
        parser.add_argument(
            "--product-revision",
            default="",
            help="The product-code revision under test, recorded in the manifest.",
        )

    def handle(self, *args: Any, **options: Any) -> None:
        if settings.APP_ENV == "production":
            raise CommandError("Load-simulation fixtures are disabled in production.")
        output_path = Path(options["output_file"]).expanduser()
        if output_path.exists():
            raise CommandError(f"Refusing to overwrite fixture file: {output_path}")
        output_path.parent.mkdir(parents=True, exist_ok=True)

        with transaction.atomic():
            admin, admin_password = self._create_user("load-sim-admin", User.Role.ADMIN)
            staff = {
                role: self._create_user(f"load-sim-staff-{role}", User.Role.STAFF)
                for role in STAFF_ROLES
            }
            operator = staff["judge-desk"][0]

            activity = self._create_activity()
            registrations, (participant, participant_password) = self._create_performers(activity)
            rounds = self._create_rounds(activity, registrations, operator)
            version = self._freeze_questionnaire_ruleset(activity, rounds, admin)
            # `prepare_round` is what seats the judges: with `judge_count` set and none assigned
            # yet it creates the round's own J1..Jn, so the panel is prepared over that set
            # rather than over judges the fixture made up separately.
            panel = self._prepare_panel(rounds["r1"], operator)
            current = self._start_performance(rounds["r1"], operator)
            activity = transition_activity_phase(
                activity, Activity.Phase.LIVE, actor=admin, note="load simulation"
            )
            vote_session, closed_session = self._prepare_votes(activity, registrations, operator)
            tickets = self._issue_tickets(activity, operator, admin)

        manifest = {
            "product_revision": options["product_revision"],
            "activity": {
                "id": activity.pk,
                "public_code": activity.public_code,
                "lifecycle": activity.data_lifecycle,
                "phase": activity.phase,
                "judge_entry_open": activity.judge_entry_open,
                "judge_entry_version": activity.judge_entry_version,
                # The capability the shared QR carries in its fragment. Without it the actors
                # would open the terminal and never claim a seat — which is exactly what the
                # first smoke run did, and it looked like a product failure instead of a
                # manifest that forgot a field.
                "judge_entry_token": judge_entry_credential(activity),
            },
            "ruleset_version_id": version.pk,
            "rounds": {key: value.pk for key, value in rounds.items()},
            "panel_snapshot_id": panel.pk,
            "judge_seats": sorted(
                seat.display_label for member in panel.members.all() for seat in member.seats.all()
            ),
            "performers": [
                {"singer_id": registration.pk, "name": registration.name}
                for registration in registrations
            ],
            "performances": [
                {
                    "id": performance.pk,
                    "singer_id": performance.singer_id,
                    "sequence": performance.sequence,
                }
                for performance in Performance.objects.filter(round=rounds["r1"]).order_by("pk")
            ],
            "current_performance_id": current.pk,
            "staff": [
                {"username": user.username, "password": password, "role": role}
                for role, (user, password) in staff.items()
            ],
            "admin": {"username": admin.username, "password": admin_password},
            "participant": {
                "username": participant.username,
                "password": participant_password,
            },
            "vote_sessions": [
                {
                    "id": vote_session.pk,
                    "name": vote_session.name,
                    "open": True,
                    "options": [
                        {"option_id": option_id, "singer_id": singer_id}
                        for option_id, singer_id in VoteOption.objects.filter(
                            vote_session=vote_session
                        ).values_list("pk", "singer_id")
                    ],
                },
                {"id": closed_session.pk, "name": closed_session.name, "open": False},
            ],
            "tickets": tickets,
        }
        output_path.write_text(
            json.dumps(manifest, ensure_ascii=True, sort_keys=True), encoding="utf-8"
        )
        try:
            os.chmod(output_path, 0o600)
        except OSError:
            pass
        self.stdout.write(
            self.style.SUCCESS(
                f"Load-simulation cast prepared: {activity.public_code} · "
                f"{len(registrations)} performers · {len(manifest['judge_seats'])} judge seats · "
                f"{sum(len(group) for group in tickets.values())} tickets."
            )
        )

    # --- accounts ---------------------------------------------------------------------

    @staticmethod
    def _create_user(prefix: str, role: str) -> tuple[User, str]:
        password = _password("LoadSim")
        with authority_write(ACCOUNT_AUTHORITY):
            user = User(username=f"{prefix}-{uuid4().hex[:12]}", role=role)
            user.set_password(password)
            user.save()  # type: ignore[no-untyped-call]
        return user, password

    # --- contest ----------------------------------------------------------------------

    @staticmethod
    def _create_activity() -> Activity:
        with authority_write(ACTIVITY_STATE):
            return Activity.objects.create(
                title="Load simulation contest",
                activity_type=Activity.Type.SINGER_CONTEST,
                phase=Activity.Phase.REHEARSAL,
                is_test_mode=False,
                judge_entry_open=True,
            )

    def _create_performers(
        self, activity: Activity
    ) -> tuple[list[SingerRegistration], tuple[User, str]]:
        """One account per performer, because a registration must belong to a user.

        The first account's credentials go into the manifest so a participant actor can log in
        and reach a real registration; the rest are fixtures with unusable passwords.
        """
        registrations = []
        participant_account: tuple[User, str] | None = None
        for index in range(PERFORMER_COUNT):
            user, password = self._create_user(
                f"load-sim-singer-{index + 1:02d}", User.Role.PARTICIPANT
            )
            if participant_account is None:
                participant_account = (user, password)
            else:
                with authority_write(ACCOUNT_AUTHORITY):
                    user.set_unusable_password()
                    user.save(update_fields=["password"])  # type: ignore[no-untyped-call]
            registrations.append(
                SingerRegistration.objects.create(
                    activity=activity,
                    user=user,
                    name=f"选手 {index + 1:02d}",
                    student_id=f"LS{index + 1:04d}",
                    college="信息工程学院",
                    class_name="计算机 2301",
                    phone=f"1380000{index:04d}",
                    song_name=f"曲目 {index + 1:02d}",
                    pre_status=SingerRegistration.PreStatus.APPROVED,
                )
            )
        if participant_account is None:
            raise CommandError("The cast needs at least one performer.")
        return registrations, participant_account

    @staticmethod
    def _create_rounds(
        activity: Activity, registrations: list[SingerRegistration], operator: User
    ) -> dict[str, ContestRound]:
        """Four rounds because the questionnaire answers per round; only the first is run."""
        rounds: dict[str, ContestRound] = {}
        for index, key in enumerate(ROUND_KEYS, start=1):
            with authority_write(CONTEST_ROUND_STATE):
                rounds[key] = ContestRound.objects.create(  # type: ignore[no-untyped-call]
                    activity=activity,
                    round_type=(
                        ContestRound.RoundType.PRELIMINARY
                        if index == 1
                        else ContestRound.RoundType.SEMI_FINAL
                    ),
                    name=f"第 {index} 轮",
                    sequence=index,
                    judge_count=JUDGE_COUNT,
                    minimum_judge_count=JUDGE_COUNT,
                    advance_count=3,
                    status=ContestRound.Status.DRAFT,
                    is_locked=False,
                )
        set_round_groups(
            rounds["r1"],
            [
                {
                    "name": "第一轮",
                    "singer_ids": [registration.pk for registration in registrations],
                }
            ],
            operator,
        )
        prepare_round(rounds["r1"], operator)
        return rounds

    @staticmethod
    def _freeze_questionnaire_ruleset(
        activity: Activity, rounds: dict[str, ContestRound], operator: User
    ) -> RulesetVersion:
        """Freezing is an admin authority, so *operator* is the fixture's administrator."""
        ruleset = ContestRuleset.objects.create(
            activity=activity, name="现场模拟赛制", stage_key="stage1"
        )
        with authority_write(RULESET_FREEZE):
            ContestRuleset.objects.filter(pk=ruleset.pk).update(
                round_keys={key: value.pk for key, value in rounds.items()}
            )
        ruleset.refresh_from_db()
        root = json.loads(DEFINITION)
        # The frozen form is the 2025 院十佳 questionnaire, so the entry pages the participants
        # hit are the ones the show actually uses.
        root["questionnaire"] = historical_2025_questionnaire()
        version = create_ruleset_version(
            ruleset, definition=json.dumps(root, ensure_ascii=False), created_by=operator
        )
        return freeze_ruleset_version(version, operator)

    @staticmethod
    def _prepare_panel(contest_round: ContestRound, operator: User) -> RoundPanelSnapshot:
        """Every judge the round carries attends; the panel is theirs by construction."""
        return prepare_judge_panel(contest_round.pk, operator=operator)

    @staticmethod
    def _start_performance(contest_round: ContestRound, operator: User) -> Performance:
        performance = contest_round.performances.order_by("sequence", "pk").first()
        if performance is None:
            raise CommandError("The prepared round has no performances to advance to.")
        advance_performance(contest_round.pk, performance.pk, operator=operator)
        return performance

    # --- audience ---------------------------------------------------------------------

    @staticmethod
    def _prepare_votes(
        activity: Activity, registrations: list[SingerRegistration], operator: User
    ) -> tuple[VoteSession, VoteSession]:
        now = timezone.now()
        live = VoteSession.objects.create(
            activity=activity,
            name="现场人气",
            start_time=now - timedelta(minutes=1),
            end_time=now + timedelta(hours=2),
            purpose=VoteSession.Purpose.POPULARITY,
            requires_ticket=True,
        )
        for registration in registrations:
            VoteOption.objects.create(vote_session=live, singer=registration)
        open_vote_session(live, operator)  # type: ignore[no-untyped-call]

        closed = VoteSession.objects.create(
            activity=activity,
            name="已结束的投票",
            start_time=now - timedelta(hours=2),
            end_time=now - timedelta(hours=1),
            purpose=VoteSession.Purpose.POPULARITY,
            requires_ticket=True,
        )
        VoteOption.objects.create(vote_session=closed, singer=registrations[0])
        close_vote_session(closed, operator)  # type: ignore[no-untyped-call]
        return live, closed

    @staticmethod
    def _issue_tickets(
        activity: Activity, operator: User, admin: User
    ) -> dict[str, list[dict[str, object]]]:
        """Tickets in the four states the plan's audience actors need.

        Each entry carries the credential the browser would scan, so the runner hands a ticket
        to an actor the same way the door does — and the four states are materially different
        rather than four labels over one row. Revoking is an admin authority (it is the response
        to a leaked code), which is why it takes the fixture's administrator.
        """
        tickets: dict[str, list[dict[str, object]]] = {
            "valid_checked_in": [],
            "valid_not_checked": [],
            "revoked": [],
            "stale_credential": [],
        }
        serial = 0
        for state, count in TICKET_COUNTS.items():
            for _ in range(count):
                serial += 1
                ticket = create_ticket(
                    activity,
                    actor=operator,
                    batch_reference="load-simulation",
                    serial_number=f"LS{serial:04d}",
                )
                issued = issue_ticket(ticket, actor=operator)
                ticket.refresh_from_db()
                credential = ticket_credential(ticket)
                if state != "valid_not_checked":
                    check_in_ticket_outcome(issued.secret, actor=operator)
                if state == "stale_credential":
                    # The printed code before the rotation: it must be refused everywhere.
                    rotate_ticket_credential(ticket, actor=operator)
                if state == "revoked":
                    revoke_ticket(ticket, actor=admin, note="load simulation")
                tickets[state].append(
                    {
                        "ticket_id": ticket.pk,
                        "serial": f"LS{serial:04d}",
                        "credential": credential,
                    }
                )
        return tickets
