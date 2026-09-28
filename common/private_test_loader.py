from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from datetime import timedelta
from decimal import Decimal
from typing import Any

from accounts.models import User
from core.models import Activity
from core.services import transition_activity_phase
from django.core.files import File
from django.db import transaction
from django.utils import timezone
from files.models import SubmissionFile
from files.services import store_submission_file
from ruleset.models import ContestRuleset
from ruleset.services import (
    create_ruleset_version,
    freeze_ruleset_version,
    update_ruleset_binding,
)
from ruleset.templates import GOLDEN_SCHIDUI_BUILTIN_KEY, seed_ruleset_templates
from singer_contest.judge_authority import (
    advance_performance,
    issue_judge_grant,
    prepare_judge_panel,
    submit_judge_score,
)
from singer_contest.models import (
    ContestRound,
    Judge,
    SingerRegistration,
)
from singer_contest.services import (
    confirm_stage_result,
    create_scoring_rubric,
    lock_round,
    materialize_round_entry_from_stage,
    maybe_resolve_checkpoints,
    prepare_round,
    recalculate_round,
    set_round_groups,
)
from tickets.services import check_in_ticket, create_ticket, issue_ticket, redeem_ticket
from voting.models import VoteOption, VoteSession
from voting.services import (
    close_vote_session,
    configure_vote_scoring_rule,
    lock_vote_session,
    open_vote_session,
    submit_ballot,
)

from common.authority import ACCOUNT_AUTHORITY, ACTIVITY_STATE, CONTEST_ROUND_STATE, authority_write
from common.private_test_fixture import PrivateTestFixture


class PrivateTestLoadError(ValueError):
    """Raised when a private rehearsal cannot be safely materialized."""


@dataclass
class PrivateLoadResult:
    activity: Activity
    report: dict[str, Any]


def _operator(username: str) -> User:
    operator = User.objects.filter(username=username).first()
    if operator is None or not operator.is_active or not operator.is_staff_or_admin:
        raise PrivateTestLoadError("operator must be an active staff/admin account")
    return operator


def _activity_for_fixture(
    fixture: PrivateTestFixture, activity_key: str, operator: User
) -> Activity:
    title = f"ArtFlow 私测｜{fixture.reference['event']['title']}"
    marker = f"private_fixture:{fixture.reference['fixture_id']}"
    candidates = list(Activity.objects.filter(subtitle=marker))
    if len(candidates) > 1:
        raise PrivateTestLoadError("multiple activities claim the same private fixture")
    if candidates:
        activity = candidates[0]
        if not activity.is_test_mode or activity.data_lifecycle != Activity.DataLifecycle.TEST:
            raise PrivateTestLoadError("fixture activity is not TEST data")
        if activity.activity_type != Activity.Type.SINGER_CONTEST:
            raise PrivateTestLoadError("fixture activity is not a singer contest")
        return activity
    if Activity.objects.filter(title=title, is_test_mode=False).exists():
        raise PrivateTestLoadError("a formal activity already uses the private rehearsal title")
    if activity_key != fixture.reference["fixture_id"]:
        raise PrivateTestLoadError("activity-key does not match the fixture id")
    with authority_write(ACTIVITY_STATE):
        return Activity.objects.create(
            title=title,
            subtitle=marker,
            activity_type=Activity.Type.SINGER_CONTEST,
            phase=Activity.Phase.TESTING,
            description="SYNTHETIC_TEST_ONLY private rehearsal; never publish.",
            is_test_mode=True,
        )


def _get_or_create_participant(row: dict[str, str]) -> User:
    username = row["username"]
    user = User.objects.filter(username=username).first()
    if user:
        if user.role != User.Role.PARTICIPANT or not user.is_active:
            raise PrivateTestLoadError(f"synthetic username has unsafe existing role: {username}")
        return user
    with authority_write(ACCOUNT_AUTHORITY):
        user = User(username=username, role=User.Role.PARTICIPANT, is_active=True)
        user.set_unusable_password()
        user.save(force_insert=True)
    return user


def _identity_by_code(fixture: PrivateTestFixture) -> dict[str, dict[str, str]]:
    return {row["contestant_code"]: row for row in fixture.identities}


def _create_registrations(
    activity: Activity, fixture: PrivateTestFixture
) -> dict[str, SingerRegistration]:
    reference_by_code = {row["legacy_code"]: row for row in fixture.reference["contestants"]}
    result: dict[str, SingerRegistration] = {}
    for row in fixture.identities:
        code = row["contestant_code"]
        source = reference_by_code.get(code)
        if source is None:
            raise PrivateTestLoadError(f"identity {code} is missing from reference fixture")
        user = _get_or_create_participant(row)
        registration = SingerRegistration.objects.filter(
            activity=activity, student_id=row["student_id"]
        ).first()
        if registration is None:
            registration = SingerRegistration.objects.create(
                activity=activity,
                user=user,
                name=row["name"],
                student_id=row["student_id"],
                college="Synthetic Test College",
                class_name="Synthetic Test Class",
                phone=row["mobile"],
                wechat="synthetic-only",
                song_name=source.get("round1_group_song") or "Synthetic rehearsal song",
                description="SYNTHETIC_TEST_ONLY",
                remark="private rehearsal fixture",
                pre_status=SingerRegistration.PreStatus.APPROVED,
                is_test_data=True,
            )
        elif (
            registration.activity_id != activity.pk
            or registration.user_id != user.pk
            or not registration.is_test_data
        ):
            raise PrivateTestLoadError(f"existing registration ownership/marker mismatch: {code}")
        result[code] = registration
    if len(result) != 15:
        raise PrivateTestLoadError("private fixture must create exactly 15 registrations")
    return result


def _create_judges(activity: Activity, fixture: PrivateTestFixture) -> dict[str, Judge]:
    result: dict[str, Judge] = {}
    for index, item in enumerate(fixture.reference["judges"], start=1):
        key = f"judge_{index:02d}"
        judge = Judge.objects.filter(
            activity=activity, name=f"Synthetic {key} · {item['name']}"
        ).first()
        if judge is None:
            judge = Judge.objects.create(
                activity=activity,
                name=f"Synthetic {key} · {item['name']}",
                is_active=True,
            )
        result[key] = judge
    if len(result) != 5:
        raise PrivateTestLoadError("private fixture must create exactly 5 judges")
    return result


def _criteria_by_round(fixture: PrivateTestFixture) -> dict[str, list[dict[str, str]]]:
    stage_map = {"第一轮": "round1", "第二轮": "round2", "第三轮": "round3", "第四轮": "round4"}
    result: dict[str, list[dict[str, str]]] = defaultdict(list)
    for item in fixture.reference["criteria"]:
        result[stage_map[item["round"]]].append(
            {"name": item["criterion"], "max_score": str(item["max_score"])}
        )
    return result


def _create_rounds_and_rubrics(
    activity: Activity,
    fixture: PrivateTestFixture,
    registrations: dict[str, SingerRegistration],
    operator: User,
) -> dict[str, ContestRound]:
    criteria_by_round = _criteria_by_round(fixture)
    round_specs = (
        ("round1", "第一轮｜分组演唱", ContestRound.RosterSource.APPROVED, 0),
        ("round2", "第二轮｜个人演唱", ContestRound.RosterSource.APPROVED, 0),
        ("round3", "第三轮｜十强合作", ContestRound.RosterSource.STAGE, 0),
        ("round4", "第四轮｜五强决赛", ContestRound.RosterSource.STAGE, 0),
    )
    rounds: dict[str, ContestRound] = {}
    for sequence, (key, name, source, advance_count) in enumerate(round_specs, start=1):
        rubric = create_scoring_rubric(
            activity,
            name=f"{name}评分标准",
            description="SYNTHETIC_TEST_ONLY; fixture criterion scale.",
            criteria=criteria_by_round[key],
            operator=operator,
        )
        round_obj = ContestRound.objects.filter(activity=activity, name=name).first()
        if round_obj is None:
            with authority_write(CONTEST_ROUND_STATE):
                round_obj = ContestRound.objects.create(
                    activity=activity,
                    round_type=(
                        ContestRound.RoundType.PRELIMINARY
                        if sequence < 3
                        else ContestRound.RoundType.SEMI_FINAL
                    ),
                    name=name,
                    sequence=sequence,
                    minimum_judge_count=3,
                    scoring_mode=ContestRound.ScoringMode.AVERAGE,
                    order_policy=ContestRound.OrderPolicy.REGISTRATION_ORDER,
                    tie_order_policy=ContestRound.TieOrderPolicy.REGISTRATION_ORDER,
                    rubric=rubric,
                    advance_count=advance_count,
                    roster_source=source,
                    roster_source_stage=(
                        "stage1" if key == "round3" else "stage2" if key == "round4" else ""
                    ),
                    status=ContestRound.Status.DRAFT,
                    is_locked=False,
                )
        elif round_obj.rubric_id != rubric.pk or round_obj.activity_id != activity.pk:
            raise PrivateTestLoadError(f"existing round configuration mismatch: {key}")
        rounds[key] = round_obj

    round1_groups = []
    for group in fixture.reference["round1_groups"]:
        codes = [
            code
            for code, row in _identity_by_code(fixture).items()
            if row["name"] in str(group["performers"]).split("；")
        ]
        round1_groups.append(
            {
                "name": f"G{group['group']}｜{group['song']}",
                "singer_ids": [registrations[c].pk for c in codes],
            }
        )
    if (
        rounds["round1"].status == ContestRound.Status.DRAFT
        and not rounds["round1"].groups.exists()
    ):
        set_round_groups(rounds["round1"], round1_groups, operator)

    # Give every later performance a concrete performance fact without inventing a
    # round FK on SubmissionFile. A one-singer group is a safe setup fact here.
    for key, song_field in (("round2", "round2_song"),):
        contest_round = rounds[key]
        if contest_round.status != ContestRound.Status.DRAFT or contest_round.groups.exists():
            continue
        source_rows = fixture.reference["contestants"]
        if key == "round3":
            source_rows = [row for row in source_rows if row.get("advanced_top10") == "YES"]
        if key == "round4":
            source_rows = [row for row in source_rows if row.get("advanced_top5") == "YES"]
        specs = []
        for item in source_rows:
            code = item["legacy_code"]
            song = item.get(song_field) or f"Synthetic {key} performance"
            specs.append({"name": f"{code}｜{song}", "singer_ids": [registrations[code].pk]})
        if specs:
            set_round_groups(contest_round, specs, operator)
    return rounds


def _set_stage_round_performances(
    contest_round, fixture, registrations, operator, *, song_field: str
) -> None:
    if contest_round.status != ContestRound.Status.DRAFT or contest_round.groups.exists():
        return
    source_rows = fixture.reference["contestants"]
    if contest_round.roster_source_stage == "stage1":
        source_rows = [row for row in source_rows if row.get("advanced_top10") == "YES"]
    if contest_round.roster_source_stage == "stage2":
        source_rows = [row for row in source_rows if row.get("advanced_top5") == "YES"]
    entries = set(contest_round.entries.values_list("singer_id", flat=True))
    specs = []
    for item in source_rows:
        code = item["legacy_code"]
        if registrations[code].pk not in entries:
            continue
        specs.append(
            {
                "name": f"{code}｜{item.get(song_field) or 'Synthetic performance'}",
                "singer_ids": [registrations[code].pk],
            }
        )
    if specs:
        set_round_groups(contest_round, specs, operator)


def _create_vote_sessions(activity: Activity, fixture: PrivateTestFixture, registrations, operator):
    now = timezone.now()
    names = {"audience1": "P1R2｜脱敏观众票", "audience4": "P2R2｜脱敏观众票"}
    sessions = {}
    top5 = {
        row["legacy_code"]
        for row in fixture.reference["contestants"]
        if row.get("advanced_top5") == "YES"
    }
    for key, name, codes in (
        ("audience1", names["audience1"], set(registrations)),
        ("audience4", names["audience4"], top5),
    ):
        session = VoteSession.objects.filter(activity=activity, name=name).first()
        if session is None:
            session = VoteSession.objects.create(
                activity=activity,
                name=name,
                passcode=f"TEST-{key}",
                start_time=now - timedelta(minutes=5),
                end_time=now + timedelta(hours=2),
                selection_type=VoteSession.SelectionType.SINGLE,
                max_selections=1,
                purpose=VoteSession.Purpose.SCORE_COMPONENT,
                requires_ticket=True,
                is_test_data=True,
            )
            options = [
                VoteOption(
                    vote_session=session,
                    singer=registrations[code],
                    sort_order=index,
                    is_test_data=True,
                )
                for index, code in enumerate(sorted(codes), start=1)
            ]
            VoteOption.objects.bulk_create(options)
        elif not session.is_test_data or session.activity_id != activity.pk:
            raise PrivateTestLoadError(f"existing vote session mismatch: {key}")
        configure_vote_scoring_rule(session, operator)
        sessions[key] = session
    return sessions


def _create_tickets_and_votes(activity, fixture, sessions, registrations, operator):
    from tickets.models import Ticket

    ticket_rows = list(fixture.ticket_rows)
    if Ticket.objects.filter(activity=activity, is_test_data=True).count() == 0:
        issued = []
        for row in ticket_rows:
            ticket = create_ticket(
                activity,
                actor=operator,
                batch_reference=f"private-{row['ticket_type']}",
                serial_number=row["synthetic_serial"],
            )
            issued.append(issue_ticket(ticket, actor=operator))
    else:
        raise PrivateTestLoadError("partial ticket import detected; reset the TEST runtime first")
    serial_to_secret = {item.ticket.serial_number: item.secret for item in issued}
    if {row["synthetic_serial"] for row in ticket_rows} != set(serial_to_secret):
        raise PrivateTestLoadError("generated ticket inventory does not match the fixture")
    for item in issued:
        check_in_ticket(item.secret, actor=operator)

    for key, rows in (("audience1", fixture.p1_votes), ("audience4", fixture.p2_votes)):
        session = open_vote_session(sessions[key], operator)
        option_by_code = {
            option.singer.student_id: option
            for option in VoteOption.objects.filter(vote_session=session).select_related("singer")
        }
        option_by_code = {option.singer.name: option for option in option_by_code.values()}
        for index, row in enumerate(rows):
            serial = ticket_rows[index]["synthetic_serial"]

            ticket_session = redeem_ticket(serial_to_secret[serial]).session
            candidate = registrations[row["contestant_code"]]
            option = option_by_code.get(candidate.name)
            if option is None:
                raise PrivateTestLoadError(
                    f"vote option missing for {row['contestant_code']} in {key}"
                )
            submit_ballot(
                session,
                browser_session_key=f"private-{key}-{index + 1:04d}",
                option_ids=[option.pk],
                ip_address=f"10.250.{1 if key == 'audience1' else 2}.{(index % 240) + 1}",
                ticket_session=ticket_session,
            )
        close_vote_session(session, operator)
        lock_vote_session(session, operator)


def _score_rows_by_cell(fixture: PrivateTestFixture):
    grouped = defaultdict(list)
    for row in fixture.score_rows:
        grouped[(row["stage"], row["contestant_code"], row["judge_key"])].append(row)
    return grouped


def _score_round(contest_round, stage, fixture, registrations, judges, operator):
    snapshot = prepare_judge_panel(
        contest_round.pk,
        operator=operator,
        attending_judge_ids=[
            judges[row["judge_key"]].pk
            for row in fixture.panel_assignments
            if row["stage"] == stage
        ],
    )
    from entry_access.services import redeem_access_grant

    tokens = {}
    for member in snapshot.members.select_related("judge").all():
        seat = member.seats.get()
        judge_key = next(key for key, judge in judges.items() if judge.pk == member.judge_id)
        tokens[judge_key] = redeem_access_grant(
            issue_judge_grant(seat.pk, operator=operator, ttl_seconds=20 * 60).token
        ).token
    cells = _score_rows_by_cell(fixture)
    for performance in contest_round.performances.select_related("singer").order_by(
        "sequence", "pk"
    ):
        run_state = advance_performance(contest_round.pk, performance.pk, operator=operator)
        for judge_key, token in tokens.items():
            rows = cells.get(
                (
                    stage,
                    next(
                        code
                        for code, reg in registrations.items()
                        if reg.pk == performance.singer_id
                    ),
                    judge_key,
                )
            )
            if not rows:
                raise PrivateTestLoadError(
                    f"missing active-panel score cell {stage}/{performance.singer_id}/{judge_key}"
                )
            rubric_criteria = list(contest_round.rubric.criteria.order_by("sequence", "pk"))
            values = {int(row["criterion_index"]): Decimal(row["score"]) for row in rows}
            submit_judge_score(
                token,
                command_id=f"private-{stage}-{performance.pk}-{judge_key}",
                expected_context_version=run_state.context_version,
                expected_performance_id=performance.pk,
                score_payload={
                    "criteria": [
                        {"criterion_id": criterion.pk, "value": values[index]}
                        for index, criterion in enumerate(rubric_criteria, start=1)
                    ],
                    "notes": "SYNTHETIC_TEST_ONLY",
                },
            )
    recalculate_round(contest_round)
    lock_round(contest_round, operator)


def _load_media(fixture, registrations, operator):
    purpose_map = {value: value for value, _ in SubmissionFile.Purpose.choices}
    for row in fixture.media_assignments:
        purpose = purpose_map.get(row["file_purpose"])
        if purpose is None:
            raise PrivateTestLoadError(f"unsupported media purpose: {row['file_purpose']}")
        source = fixture.root / "07_realistic_test_addendum" / row["relative_file"]
        if not source.is_file():
            raise PrivateTestLoadError(f"media file missing: {row['relative_file']}")
        owner = registrations[row["contestant_code"]]
        with source.open("rb") as handle:
            uploaded = File(handle, name=source.name)
            uploaded.content_type = {
                ".wav": "audio/wav",
                ".mp4": "video/mp4",
                ".png": "image/png",
                ".txt": "text/plain",
            }.get(source.suffix.lower(), "application/octet-stream")
            store_submission_file(
                owner=owner, uploaded_file=uploaded, purpose=purpose, uploaded_by=operator
            )


def _load_scores_and_results(activity, fixture, rounds, registrations, judges, operator):
    _score_round(rounds["round1"], "round1", fixture, registrations, judges, operator)
    _score_round(rounds["round2"], "round2", fixture, registrations, judges, operator)
    for phase in (
        Activity.Phase.REGISTRATION_OPEN,
        Activity.Phase.REGISTRATION_CLOSED,
        Activity.Phase.REVIEWING,
        Activity.Phase.REHEARSAL,
        Activity.Phase.LIVE,
        Activity.Phase.RESULTS_PENDING,
    ):
        activity = transition_activity_phase(
            activity, phase, actor=operator, note="private rehearsal lifecycle"
        )
    activity.refresh_from_db()
    resolved = maybe_resolve_checkpoints(activity, operator)
    stage1 = activity.stage_results.get(stage_key="stage1")
    if stage1.status != "ready_to_confirm":
        raise PrivateTestLoadError(f"stage1 did not become ready: {stage1.status}")
    confirm_stage_result(stage1, confirmed_by=operator)
    round3 = materialize_round_entry_from_stage(stage1, operator=operator)
    if round3 is None:
        raise PrivateTestLoadError("stage1 did not materialize round3")
    _set_stage_round_performances(
        round3, fixture, registrations, operator, song_field="actual_round3_song"
    )
    prepare_round(round3, operator)
    round3.refresh_from_db()
    _score_round(round3, "round3", fixture, registrations, judges, operator)
    maybe_resolve_checkpoints(activity, operator)
    stage2_result = activity.stage_results.get(stage_key="stage2")
    confirm_stage_result(stage2_result, confirmed_by=operator)
    round4 = materialize_round_entry_from_stage(stage2_result, operator=operator)
    if round4 is None:
        raise PrivateTestLoadError("stage2 did not materialize round4")
    _set_stage_round_performances(
        round4, fixture, registrations, operator, song_field="actual_final_song_raw"
    )
    prepare_round(round4, operator)
    round4.refresh_from_db()
    _score_round(round4, "round4", fixture, registrations, judges, operator)
    maybe_resolve_checkpoints(activity, operator)
    stage3 = activity.stage_results.get(stage_key="stage3")
    confirm_stage_result(stage3, confirmed_by=operator)
    top = list(
        stage3.decisions.filter(rank__lte=3)
        .order_by("rank")
        .values_list("singer__student_id", flat=True)
    )
    return {"resolved_checkpoints": resolved, "top3_student_ids": top}


@transaction.atomic
def apply_private_fixture(
    fixture: PrivateTestFixture,
    *,
    activity_key: str,
    operator_username: str,
    reset_test_runtime: bool = False,
) -> PrivateLoadResult:
    operator = _operator(operator_username)
    activity = _activity_for_fixture(fixture, activity_key, operator)
    if not activity.is_test_mode or activity.data_lifecycle != Activity.DataLifecycle.TEST:
        raise PrivateTestLoadError("private fixture may only run in TEST lifecycle")
    if reset_test_runtime:
        from common.test_data import clear_activity_test_data

        clear_activity_test_data(activity, operator=operator)
        activity.refresh_from_db()
    elif activity.singer_registrations.filter(is_test_data=True).exists():
        from singer_contest.models import StageResult

        complete = (
            activity.singer_registrations.filter(is_test_data=True).count() == 15
            and activity.rounds.count() == 4
            and StageResult.objects.filter(
                activity=activity,
                stage_key="stage3",
                status=StageResult.Status.CONFIRMED,
                is_test_data=True,
            ).exists()
        )
        if complete:
            return PrivateLoadResult(
                activity=activity,
                report={
                    "activity_id": activity.pk,
                    "fixture_id": fixture.reference["fixture_id"],
                    "status": "already_loaded_noop",
                    "provenance": "SYNTHETIC_TEST_ONLY",
                },
            )
        raise PrivateTestLoadError(
            "fixture activity contains partial data; use --reset-test-runtime"
        )

    registrations = _create_registrations(activity, fixture)
    judges = _create_judges(activity, fixture)
    rounds = _create_rounds_and_rubrics(activity, fixture, registrations, operator)
    for key in ("round1", "round2"):
        prepare_round(rounds[key], operator)
    sessions = _create_vote_sessions(activity, fixture, registrations, operator)
    template_count = seed_ruleset_templates(operator)
    from ruleset.models import RulesetTemplate

    template = RulesetTemplate.objects.filter(builtin_key=GOLDEN_SCHIDUI_BUILTIN_KEY).first()
    if template is None:
        raise PrivateTestLoadError("golden_schidui ruleset template is unavailable")
    ruleset = ContestRuleset.objects.filter(activity=activity).first()
    if ruleset is None:
        ruleset = ContestRuleset.objects.create(
            activity=activity,
            name="院十佳私测冻结赛制",
            source_template=template,
            is_test_data=True,
            created_by=operator,
        )
    binding = {
        "stage_key": "stage3",
        "round_keys": {key.replace("round", "r"): value.pk for key, value in rounds.items()},
        "vote_keys": {"audience1": sessions["audience1"].pk, "audience4": sessions["audience4"].pk},
        "vote_scoring_rule_keys": {
            "audience1": sessions["audience1"].scoring_rule.pk,
            "audience4": sessions["audience4"].scoring_rule.pk,
        },
        "group_keys": {"initial_group": rounds["round1"].pk},
    }
    update_ruleset_binding(ruleset, binding=binding, operator=operator)
    version = create_ruleset_version(ruleset, definition=template.definition, created_by=operator)
    freeze_ruleset_version(version, operator)
    _create_tickets_and_votes(activity, fixture, sessions, registrations, operator)
    _load_media(fixture, registrations, operator)
    result = _load_scores_and_results(activity, fixture, rounds, registrations, judges, operator)
    result.update(
        {
            "activity_id": activity.pk,
            "fixture_id": fixture.reference["fixture_id"],
            "registrations": len(registrations),
            "judges": len(judges),
            "rounds": len(rounds),
            "media_assignments": len(fixture.media_assignments),
            "p1_ballots": len(fixture.p1_votes),
            "p2_ballots": len(fixture.p2_votes),
            "tickets": len(fixture.ticket_rows),
            "template_seeded": template_count,
            "provenance": "SYNTHETIC_TEST_ONLY",
        }
    )
    return PrivateLoadResult(activity=activity, report=result)
