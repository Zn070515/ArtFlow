"""Audited services for the chronological live challenge stage."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Iterable
from decimal import Decimal
from typing import Any

from accounts.services import require_current_admin, require_current_staff
from common.authority import CONTEST_ROUND_STATE, LIVE_CHALLENGE_STATE, authority_write
from common.models import AuditLog
from core.policies import ActivityAction
from core.services import lock_activity_for_action
from django.core.exceptions import PermissionDenied, ValidationError
from django.db import transaction
from django.db.models import Max
from django.utils import timezone
from questionnaire.projection import questionnaire_song_for_key
from ruleset.models import RulesetVersion
from ruleset.services import LIVE_CHALLENGE_FORMAT_KEY, current_frozen_version

from .materials import LIVE_PERSONAL_ROUNDS
from .models import (
    ChallengeCommand,
    ChallengeMatch,
    ChallengeSeat,
    ChallengeSession,
    ChallengeTurn,
    ContestRound,
    Judge,
    Performance,
    PerformanceRunState,
    PerformanceScoreState,
    RoundEntry,
    RoundJudge,
    ScoreSummary,
    SingerRegistration,
)
from .scoring import (
    official_weighted_score,
    quantize_official_score,
    scoring_standard_matches,
)


class ChallengeIdempotencyConflict(ValidationError):
    """A command id was already used for a different live-challenge command."""


def _command_id(value: object) -> str:
    if not isinstance(value, str) or not value.strip() or len(value.strip()) > 64:
        raise ValidationError("踢馆 command_id 无效。")
    return value.strip()


def _expected_revision(value: object) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ValidationError("踢馆会话版本无效。")
    return value


def _weight(value: object, *, field: str) -> Decimal:
    try:
        weight = Decimal(str(value))
    except Exception as exc:
        raise ValidationError(f"{field} 必须是有效的小数权重。") from exc
    if weight <= 0 or weight >= 1:
        raise ValidationError(f"{field} 必须大于 0 且小于 1。")
    return weight.quantize(Decimal("0.0001"))


def _configured_weights(
    version: RulesetVersion,
    first_round_weight: object | None,
    challenge_round_weight: object | None,
) -> tuple[Decimal, Decimal]:
    config = (version.binding or {}).get("live_challenge")
    if not isinstance(config, dict):
        raise ValidationError("冻结赛制尚未配置踢馆成绩权重。")
    configured_first = _weight(config.get("first_round_weight"), field="first_round_weight")
    configured_challenge = _weight(
        config.get("challenge_round_weight"), field="challenge_round_weight"
    )
    if configured_first + configured_challenge != Decimal("1.0000"):
        raise ValidationError("冻结赛制的第一轮与踢馆成绩权重必须合计 100%。")
    if first_round_weight is not None or challenge_round_weight is not None:
        raise ValidationError("踢馆成绩权重只能从冻结赛制读取，不能在运行时覆盖。")
    return configured_first, configured_challenge


def _live_counts(version: RulesetVersion):
    """The 2026 counts as frozen on this version — same source as the weights above."""

    from ruleset.live_format import live_challenge_counts

    return live_challenge_counts(version)


def _hash_payload(payload: dict[str, Any]) -> str:
    return hashlib.sha256(
        json.dumps(payload, ensure_ascii=True, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def _source_fingerprint(round_: ContestRound, summaries: Iterable[ScoreSummary]) -> str:
    rows = [
        {
            "singer_id": summary.singer_id,
            "official_number": summary.singer.official_number,
            "score": str(summary.average_score),
            "rank": summary.rank,
            "is_advanced": summary.is_advanced,
        }
        for summary in summaries
    ]
    return _hash_payload(
        {
            "round_id": round_.pk,
            "score_version": round_.score_version,
            "status": round_.status,
            "advancement_status": round_.advancement_status,
            "rows": rows,
        }
    )


def _current_ruleset_hash(version: RulesetVersion) -> str:
    return str(version.authority_hash or version.content_hash or "")


def _record_audit(
    *, operator, action_type: str, target: str, new_value: dict[str, Any], old_value=None
):
    return AuditLog.objects.create(
        operator=operator,
        action_type=action_type,
        target=target,
        old_value=json.dumps(old_value or {}, ensure_ascii=False, sort_keys=True),
        new_value=json.dumps(new_value, ensure_ascii=False, sort_keys=True),
    )


def _write_command(
    *,
    session: ChallengeSession,
    command_id: str,
    operation: str,
    payload_hash: str,
    operator,
    result_type: str,
    result_id: int,
    result_payload: dict[str, Any],
) -> ChallengeCommand:
    with authority_write(LIVE_CHALLENGE_STATE):
        return ChallengeCommand.objects.create(
            session=session,
            command_id=command_id,
            operation=operation,
            payload_hash=payload_hash,
            operator=operator,
            result_type=result_type,
            result_id=result_id,
            result_payload=result_payload,
        )


def _replay_command(
    *,
    session: ChallengeSession,
    command_id: str,
    operation: str,
    payload_hash: str,
    result_model,
):
    command = ChallengeCommand.objects.select_for_update().filter(command_id=command_id).first()
    if command is None:
        return None
    if (
        command.session_id != session.pk
        or command.operation != operation
        or command.payload_hash != payload_hash
    ):
        raise ChallengeIdempotencyConflict("踢馆命令已绑定其他操作内容。")
    return result_model._base_manager.get(pk=command.result_id)


def _session_for_update(session_id: int, operator):
    current_operator = require_current_staff(operator)
    initial = ChallengeSession.objects.select_related("activity").filter(pk=session_id).first()
    if initial is None:
        raise ValidationError("踢馆会话不存在。")
    locked_activity = lock_activity_for_action(initial.activity, ActivityAction.SCORE)
    session = (
        ChallengeSession.objects.select_for_update()
        .select_related("activity", "source_round", "ruleset_version")
        .get(pk=session_id)
    )
    if session.activity_id != locked_activity.pk:
        raise ValidationError("踢馆会话活动上下文不一致。")
    return current_operator, session


def _challenge_match_performance(session: ChallengeSession, role: str):
    if role not in {"challenger", "defender"}:
        raise ValidationError("挑战评分对象无效。")
    match = (
        ChallengeMatch.objects.select_for_update()
        .select_related("turn", "challenger", "defender")
        .filter(session=session, turn__sequence=session.current_turn_number)
        .first()
    )
    if match is None or match.score_round_id is None:
        raise ValidationError("当前比赛尚未准备评分。")
    if match.status != ChallengeMatch.Status.SCORING:
        raise ValidationError("当前比赛不在收分阶段。")
    score_round = ContestRound.objects.select_for_update().get(pk=match.score_round_id)
    singer_id = match.challenger_id if role == "challenger" else match.defender_id
    performance = (
        Performance.objects.select_for_update()
        .filter(round=score_round, singer_id=singer_id)
        .first()
    )
    if performance is None:
        raise ValidationError("当前比赛缺少对应评分对象。")
    return match, score_round, performance


def _configured_live_judges(
    session: ChallengeSession, *, ids_key: str, minimum_key: str, label: str
) -> tuple[list[Judge], int]:
    config = (session.ruleset_version.binding or {}).get("live_challenge")
    if not isinstance(config, dict):
        raise ValidationError("冻结赛制尚未配置现场轮次评委名单。")
    raw_ids = config.get(ids_key)
    if not isinstance(raw_ids, list) or not raw_ids:
        raise ValidationError(f"冻结赛制尚未配置{label}评委名单。")
    try:
        judge_ids = [int(value) for value in raw_ids]
        minimum = int(config[minimum_key])
    except (KeyError, TypeError, ValueError):
        raise ValidationError(f"冻结赛制的{label}评委配置无效。") from None
    if any(judge_id < 1 for judge_id in judge_ids) or len(judge_ids) != len(set(judge_ids)):
        raise ValidationError(f"冻结赛制的{label}评委配置无效。")
    if not 1 <= minimum <= len(judge_ids):
        raise ValidationError(f"冻结赛制的{label}最低有效评委数无效。")
    judges_by_id = {
        judge.pk: judge
        for judge in Judge.objects.filter(
            activity_id=session.activity_id, pk__in=judge_ids, is_active=True
        )
    }
    if set(judges_by_id) != set(judge_ids):
        raise ValidationError(f"冻结赛制的{label}评委名单包含不存在或未启用的评委。")
    return [judges_by_id[judge_id] for judge_id in judge_ids], minimum


@transaction.atomic
def advance_challenge_performance(
    session_id: int,
    *,
    role: str,
    operator,
    command_id: object,
    expected_revision: object,
) -> PerformanceRunState:
    """Open a challenge contestant through the audited, ordered console boundary."""

    current_operator, session = _session_for_update(session_id, operator)
    normalized_command = _command_id(command_id)
    payload_hash = _hash_payload(
        {
            "operation": "challenge.performance.open",
            "session_id": session.pk,
            "role": role,
            "expected_revision": expected_revision,
        }
    )
    replay = _replay_command(
        session=session,
        command_id=normalized_command,
        operation="challenge.performance.open",
        payload_hash=payload_hash,
        result_model=PerformanceRunState,
    )
    if replay is not None:
        return replay
    _check_revision(session, expected_revision)
    _ensure_session_dependencies_current(session)
    match, score_round, performance = _challenge_match_performance(session, role)
    if role == "defender":
        challenger_state = PerformanceScoreState.objects.filter(
            performance__round=score_round,
            performance__singer_id=match.challenger_id,
        ).first()
        if (
            challenger_state is None
            or challenger_state.state == PerformanceScoreState.State.NOT_OPENED
        ):
            raise ValidationError("请先开放挑战者评分，再开放守擂者评分。")
    from .judge_authority import advance_performance

    run_state = advance_performance(score_round.pk, performance.pk, operator=current_operator)
    _bump(session)
    with authority_write(LIVE_CHALLENGE_STATE):
        session.save(update_fields=["revision", "updated_at"])
        _write_command(
            session=session,
            command_id=normalized_command,
            operation="challenge.performance.open",
            payload_hash=payload_hash,
            operator=current_operator,
            result_type="PerformanceRunState",
            result_id=run_state.pk,
            result_payload={"round_id": score_round.pk, "performance_id": performance.pk},
        )
    return run_state


@transaction.atomic
def lock_challenge_performance(
    session_id: int,
    *,
    role: str,
    operator,
    command_id: object,
    expected_revision: object,
    expected_context_version: object,
) -> PerformanceScoreState:
    """Lock one challenge contestant after the panel minimum is met."""

    current_operator, session = _session_for_update(session_id, operator)
    normalized_command = _command_id(command_id)
    payload_hash = _hash_payload(
        {
            "operation": "challenge.performance.lock",
            "session_id": session.pk,
            "role": role,
            "expected_revision": expected_revision,
            "expected_context_version": expected_context_version,
        }
    )
    replay = _replay_command(
        session=session,
        command_id=normalized_command,
        operation="challenge.performance.lock",
        payload_hash=payload_hash,
        result_model=PerformanceScoreState,
    )
    if replay is not None:
        return replay
    _check_revision(session, expected_revision)
    _ensure_session_dependencies_current(session)
    match, score_round, performance = _challenge_match_performance(session, role)
    if role == "defender":
        challenger_state = PerformanceScoreState.objects.filter(
            performance__round=score_round,
            performance__singer_id=match.challenger_id,
        ).first()
        if (
            challenger_state is None
            or challenger_state.state == PerformanceScoreState.State.NOT_OPENED
        ):
            raise ValidationError("请先开放挑战者评分，再锁定守擂者评分。")
    from .judge_authority import lock_performance_score

    score_state = lock_performance_score(
        score_round.pk,
        performance.pk,
        operator=current_operator,
        expected_context_version=expected_context_version,
    )
    _bump(session)
    with authority_write(LIVE_CHALLENGE_STATE):
        session.save(update_fields=["revision", "updated_at"])
        _write_command(
            session=session,
            command_id=normalized_command,
            operation="challenge.performance.lock",
            payload_hash=payload_hash,
            operator=current_operator,
            result_type="PerformanceScoreState",
            result_id=score_state.pk,
            result_payload={"round_id": score_round.pk, "performance_id": performance.pk},
        )
    return score_state


def _check_revision(session: ChallengeSession, expected_revision: object) -> None:
    if session.revision != _expected_revision(expected_revision):
        raise ValidationError("踢馆会话已被其他工作人员更新，请刷新后重试。")


def _bump(session: ChallengeSession) -> None:
    session.revision += 1


def _finish_turn(session: ChallengeSession, turn: ChallengeTurn) -> None:
    if turn.sequence == _live_counts(session.ruleset_version).challenge_count:
        session.state = ChallengeSession.State.READY_TO_CONFIRM
    else:
        session.current_turn_number = turn.sequence + 1


def _ensure_session_dependencies_current(
    session: ChallengeSession, *, lock_dependencies: bool = True
) -> None:
    source_rounds = ContestRound.objects.all()
    versions = RulesetVersion.objects.select_related("ruleset")
    if lock_dependencies:
        source_rounds = source_rounds.select_for_update()
        versions = versions.select_for_update()
    source_round = source_rounds.get(pk=session.source_round_id, activity_id=session.activity_id)
    version = versions.get(pk=session.ruleset_version_id)
    # Defense in depth: the freeze finality gate should make a successor unable to replace
    # this authority, but a legacy/restored row or an internal caller could still present a
    # session bound to a retired version. No live command may act under it.
    current = current_frozen_version(session.activity)
    if current is None or current.pk != version.pk:
        raise ValidationError("当前正式赛制已变化，当前踢馆会话不能继续沿用。")
    summaries = _validate_source_round(source_round, version)
    current_source_fp = _source_fingerprint(source_round, summaries)
    current_ruleset_hash = _current_ruleset_hash(version)
    if current_source_fp != session.source_roster_fingerprint:
        raise ValidationError("第一轮正式结果已变化，当前踢馆会话不能继续沿用。")
    if current_ruleset_hash != session.ruleset_hash:
        raise ValidationError("冻结赛制版本已变化，当前踢馆会话不能继续沿用。")


def challenge_final_roster(
    session_id: int, *, activity_id: int | None = None
) -> list[SingerRegistration]:
    """Return the confirmed ten-seat roster in its frozen third-round positions.

    This is the only read boundary a final round may use.  A caller cannot turn a
    partially processed challenge session into a roster, and the dependency check keeps
    a later first-round/ruleset correction from being silently consumed by the final.
    """
    session = ChallengeSession._base_manager.select_related("activity").get(pk=session_id)
    if activity_id is not None and session.activity_id != activity_id:
        raise ValidationError("踢馆会话不属于当前活动。")
    if session.state != ChallengeSession.State.CONFIRMED:
        raise ValidationError("踢馆会话尚未核定，不能生成最终十强名单。")
    _ensure_session_dependencies_current(session, lock_dependencies=False)
    seats = list(
        ChallengeSeat._base_manager.filter(session=session).order_by("third_round_position", "pk")
    )
    holder_ids = [seat.current_holder_id for seat in seats]
    seat_count = _live_counts(session.ruleset_version).seat_count
    if len(seats) != seat_count or len(set(holder_ids)) != seat_count:
        raise ValidationError(f"核定后的踢馆会话必须保有 {seat_count} 个不同席位持有人。")
    singers = {
        singer.pk: singer
        for singer in SingerRegistration._base_manager.filter(
            activity_id=session.activity_id,
            pk__in=holder_ids,
        )
    }
    if set(singers) != set(holder_ids):
        raise ValidationError("踢馆席位中存在不属于当前活动的选手。")
    return [singers[singer_id] for singer_id in holder_ids]


def _validate_source_round(
    round_: ContestRound, ruleset_version: RulesetVersion
) -> list[ScoreSummary]:
    if round_.activity_id != ruleset_version.ruleset.activity_id:
        raise ValidationError("第一轮和冻结赛制不属于同一活动。")
    if round_.status != ContestRound.Status.LOCKED or not round_.is_locked:
        raise ValidationError("第一轮必须先锁定后才能建立踢馆会话。")
    if round_.advancement_status != ContestRound.AdvancementStatus.FINALIZED:
        raise ValidationError("第一轮晋级名单尚未核定。")
    if ruleset_version.status != RulesetVersion.Status.FROZEN:
        raise ValidationError("踢馆会话必须绑定冻结赛制版本。")
    binding = ruleset_version.binding or {}
    live_config = binding.get("live_challenge") or {}
    if isinstance(live_config, dict) and live_config.get("format_key") == LIVE_CHALLENGE_FORMAT_KEY:
        if round_.scoring_mode != ContestRound.ScoringMode.AVERAGE:
            raise ValidationError("2026 现场赛制必须使用所有有效评委分的算术平均。")
        first_key = str(live_config.get("podium_first_round_key") or "r1").strip()
        round_keys = binding.get("round_keys") or {}
        if not isinstance(round_keys, dict):
            raise ValidationError("冻结赛制的第一轮绑定无效。")
        bound_round_id = round_keys.get(first_key)
        if str(bound_round_id) != str(round_.pk):
            raise ValidationError("挑战会话只能从冻结赛制绑定的第一轮建立。")
        frozen_standard = live_config.get("scoring_standard")
        if not scoring_standard_matches(round_, frozen_standard):
            raise ValidationError("第一轮当前评分标准与冻结赛制不一致。")
    summaries = list(
        ScoreSummary.objects.select_related("singer")
        .filter(round=round_, singer__pre_status=SingerRegistration.PreStatus.APPROVED)
        .order_by("singer_id")
    )
    counts = _live_counts(ruleset_version)
    if len(summaries) != counts.participant_count:
        raise ValidationError(f"第一轮必须恰好有 {counts.participant_count} 名已核定选手。")
    if any(summary.singer.official_number is None for summary in summaries):
        raise ValidationError("所有第一轮选手必须先配置官方选手编号。")
    if len({summary.singer.official_number for summary in summaries}) != counts.participant_count:
        raise ValidationError("官方选手编号必须在活动内唯一。")
    scores = [summary.average_score for summary in summaries]
    if len(set(scores)) != len(scores):
        raise ValidationError("第一轮出现同分，不能自动建立踢馆顺序。")
    ranked = sorted(summaries, key=lambda row: row.average_score, reverse=True)
    expected_advanced = {row.singer_id for row in ranked[: counts.seat_count]}
    actual_advanced = {row.singer_id for row in summaries if row.is_advanced}
    if actual_advanced != expected_advanced:
        raise ValidationError("第一轮晋级标记与正式成绩排名不一致。")
    if len(actual_advanced) != counts.seat_count:
        raise ValidationError(f"第一轮必须核定 {counts.seat_count} 个初始席位。")
    return summaries


@transaction.atomic
def create_challenge_session(
    source_round: ContestRound,
    *,
    ruleset_version: RulesetVersion,
    operator,
    command_id: object,
    first_round_weight: object | None = None,
    challenge_round_weight: object | None = None,
) -> ChallengeSession:
    current_operator = require_current_staff(operator)
    normalized_command = _command_id(command_id)
    initial_round = ContestRound.objects.select_related("activity").get(pk=source_round.pk)
    locked_activity = lock_activity_for_action(initial_round.activity, ActivityAction.SCORE)
    locked_round = ContestRound.objects.select_for_update().get(pk=initial_round.pk)
    locked_version = (
        RulesetVersion.objects.select_for_update()
        .select_related("ruleset")
        .get(pk=ruleset_version.pk)
    )
    # The caller names a version, but the activity's current FROZEN authority is the only
    # one that may materialise live challenge state. The Staff UI already passes the same
    # version; enforcing it here keeps the service correct for every other caller.
    current = current_frozen_version(locked_activity)
    if current is None or current.pk != locked_version.pk:
        raise ValidationError("踢馆会话只能从当前正式赛制建立。")
    first_weight, challenge_weight = _configured_weights(
        locked_version, first_round_weight, challenge_round_weight
    )
    summaries = _validate_source_round(locked_round, locked_version)
    source_fp = _source_fingerprint(locked_round, summaries)
    ruleset_hash = _current_ruleset_hash(locked_version)
    input_fp = _hash_payload(
        {
            "source_fingerprint": source_fp,
            "ruleset_hash": ruleset_hash,
            "ruleset_version_id": locked_version.pk,
        }
    )
    payload_hash = _hash_payload(
        {
            "operation": "challenge.session.create",
            "source_round_id": locked_round.pk,
            "ruleset_version_id": locked_version.pk,
            "input_fingerprint": input_fp,
            "first_round_weight": str(first_weight),
            "challenge_round_weight": str(challenge_weight),
        }
    )
    existing_command = (
        ChallengeCommand.objects.select_for_update().filter(command_id=normalized_command).first()
    )
    if existing_command is not None:
        if (
            existing_command.operation != "challenge.session.create"
            or existing_command.payload_hash != payload_hash
        ):
            raise ChallengeIdempotencyConflict("踢馆命令已绑定其他创建内容。")
        if existing_command.result_id is None:
            raise ValidationError("踢馆创建命令缺少结果记录。")
        return ChallengeSession._base_manager.get(pk=existing_command.result_id)
    # A revoked session is history. The same first-round result may be allowed to establish
    # a fresh session after the mistaken one was withdrawn (the partial unique constraint in
    # ChallengeSession.Meta enforces the same rule at the database boundary).
    existing_session = (
        ChallengeSession.objects.filter(input_fingerprint=input_fp)
        .exclude(state=ChallengeSession.State.REVOKED)
        .first()
    )
    if existing_session is not None:
        raise ValidationError("该第一轮结果已经建立踢馆会话。")
    ranked = sorted(summaries, key=lambda row: row.average_score, reverse=True)

    def _official_number(summary: ScoreSummary) -> int:
        if summary.singer.official_number is None:
            raise ValidationError("所有第一轮选手必须先配置官方选手编号。")
        return summary.singer.official_number

    # Everyone left without an initial seat challenges exactly once, so the queue length is
    # the derived 踢馆人数 — a divergence would be caught by the confirm-time turn count, not
    # silently truncated here.
    counts = _live_counts(locked_version)
    seats = sorted(ranked[: counts.seat_count], key=_official_number)
    challengers = sorted(ranked[counts.seat_count :], key=lambda row: row.average_score)
    with authority_write(LIVE_CHALLENGE_STATE):
        session = ChallengeSession.objects.create(
            activity=locked_activity,
            source_round=locked_round,
            ruleset_version=locked_version,
            state=ChallengeSession.State.ACTIVE,
            source_score_version=locked_round.score_version,
            source_roster_fingerprint=source_fp,
            ruleset_hash=ruleset_hash,
            input_fingerprint=input_fp,
            first_round_weight=first_weight,
            challenge_round_weight=challenge_weight,
            created_by=current_operator,
            is_test_data=locked_activity.is_test_mode,
        )
        ChallengeSeat.objects.bulk_create(
            [
                ChallengeSeat(
                    session=session,
                    position=index,
                    initial_holder=row.singer,
                    current_holder=row.singer,
                    third_round_position=index,
                    is_test_data=session.is_test_data,
                )
                for index, row in enumerate(seats, start=1)
            ]
        )
        ChallengeTurn.objects.bulk_create(
            [
                ChallengeTurn(
                    session=session,
                    sequence=index,
                    challenger=row.singer,
                    is_test_data=session.is_test_data,
                )
                for index, row in enumerate(challengers, start=1)
            ]
        )
        _write_command(
            session=session,
            command_id=normalized_command,
            operation="challenge.session.create",
            payload_hash=payload_hash,
            operator=current_operator,
            result_type="ChallengeSession",
            result_id=session.pk,
            result_payload={"session_id": session.pk, "input_fingerprint": input_fp},
        )
    _record_audit(
        operator=current_operator,
        action_type=AuditLog.ActionType.CHALLENGE_SESSION_CREATE,
        target=f"ChallengeSession:{session.pk}",
        new_value={
            "source_round_id": locked_round.pk,
            "ruleset_version_id": locked_version.pk,
            "source_roster_fingerprint": source_fp,
            "challengers": [turn.challenger_id for turn in session.turns.order_by("sequence")],
            "seats": [seat.current_holder_id for seat in session.seats.order_by("position")],
        },
    )
    return session


def challenge_session_revoke_blocker(session: ChallengeSession) -> str | None:
    """Why this session may not be revoked, or ``None`` in the pre-start window.

    Shared by the service and the console so the button and the command cannot disagree.
    The window is deliberately narrow: before the first turn moves, a mistake is only a
    frozen copy of the first-round result, and withdrawing it restores the ordinary
    unlock/reset path. Once the venue has acted, the session is event history.
    """

    if session.state != ChallengeSession.State.ACTIVE:
        return "只有尚未开始的进行中踢馆会话可以撤销。"
    if (
        ChallengeTurn.objects.filter(session=session)
        .exclude(state=ChallengeTurn.State.PENDING)
        .exists()
    ):
        return "已经有挑战机会开始处理，不能撤销踢馆会话；请登记事故并走完整纠正流程。"
    if ChallengeMatch.objects.filter(session=session).exists():
        return "已经建立踢馆比赛，不能撤销踢馆会话；请登记事故并走完整纠正流程。"
    if ContestRound.objects.filter(
        roster_source=ContestRound.RosterSource.CHALLENGE_SESSION,
        roster_source_challenge_session=session,
    ).exists():
        return "已经生成第三轮名单，不能撤销踢馆会话；请登记事故并走完整纠正流程。"
    if any(
        seat.current_holder_id != seat.initial_holder_id
        for seat in ChallengeSeat.objects.filter(session=session)
    ):
        return "席位持有人已经变化，不能撤销踢馆会话；请登记事故并走完整纠正流程。"
    return None


@transaction.atomic
def revoke_challenge_session(
    session_id: int,
    *,
    operator,
    command_id: object,
    expected_revision: object,
    reason: str,
) -> ChallengeSession:
    """Withdraw a challenge session that has not started its first match.

    This is the narrow recovery path behind the round-reset/unlock and successor-freeze
    refusals. It exists so a mistaken creation — or a first-round score that must be
    corrected thirty seconds later — is recoverable without touching the database. Once a
    turn moves, a match exists or a final round is generated, the venue has acted on the
    session and only the full incident process may unwind it.
    """

    current_operator = require_current_admin(operator)
    normalized_reason = (reason or "").strip()
    if not normalized_reason:
        raise ValidationError("撤销踢馆会话必须填写原因。")
    _, session = _session_for_update(session_id, current_operator)
    normalized_command = _command_id(command_id)
    payload_hash = _hash_payload(
        {
            "operation": "challenge.session.revoke",
            "session_id": session.pk,
            "expected_revision": expected_revision,
            "reason": normalized_reason,
        }
    )
    replay = _replay_command(
        session=session,
        command_id=normalized_command,
        operation="challenge.session.revoke",
        payload_hash=payload_hash,
        result_model=ChallengeSession,
    )
    if replay is not None:
        return replay
    _check_revision(session, expected_revision)
    blocker = challenge_session_revoke_blocker(session)
    if blocker is not None:
        raise ValidationError(blocker)
    old_state = session.state
    with authority_write(LIVE_CHALLENGE_STATE):
        session.state = ChallengeSession.State.REVOKED
        session.revision += 1
        session.save(update_fields=["state", "revision", "updated_at"])
        _write_command(
            session=session,
            command_id=normalized_command,
            operation="challenge.session.revoke",
            payload_hash=payload_hash,
            operator=current_operator,
            result_type="ChallengeSession",
            result_id=session.pk,
            result_payload={"session_id": session.pk, "reason": normalized_reason},
        )
    _record_audit(
        operator=current_operator,
        action_type=AuditLog.ActionType.CHALLENGE_SESSION_REVOKE,
        target=f"ChallengeSession:{session.pk}",
        old_value={"state": old_state},
        new_value={"state": ChallengeSession.State.REVOKED, "reason": normalized_reason},
    )
    return session


@transaction.atomic
def start_challenge_turn(
    session_id: int,
    *,
    operator,
    command_id: object,
    expected_revision: object,
) -> ChallengeTurn:
    current_operator, session = _session_for_update(session_id, operator)
    normalized_command = _command_id(command_id)
    payload_hash = _hash_payload(
        {
            "operation": "challenge.turn.start",
            "session_id": session.pk,
            "expected_revision": expected_revision,
        }
    )
    replay = _replay_command(
        session=session,
        command_id=normalized_command,
        operation="challenge.turn.start",
        payload_hash=payload_hash,
        result_model=ChallengeTurn,
    )
    if replay is not None:
        return replay
    _check_revision(session, expected_revision)
    _ensure_session_dependencies_current(session)
    if session.state == ChallengeSession.State.READY_TO_CONFIRM:
        counts = _live_counts(session.ruleset_version)
        raise ValidationError(f"{counts.challenge_count} 次踢馆机会已经处理完，请确认最终名单。")
    if session.state != ChallengeSession.State.ACTIVE:
        raise PermissionDenied("当前踢馆会话不可开始挑战选择。")
    turn = ChallengeTurn.objects.select_for_update().get(
        session=session, sequence=session.current_turn_number
    )
    if turn.state == ChallengeTurn.State.PENDING:
        turn.state = ChallengeTurn.State.SELECTING
        turn.revision += 1
        turn.acted_by = current_operator
        turn.acted_at = timezone.now()
        with authority_write(LIVE_CHALLENGE_STATE):
            turn.save(update_fields=["state", "revision", "acted_by", "acted_at"])
        _bump(session)
        with authority_write(LIVE_CHALLENGE_STATE):
            session.save(update_fields=["revision", "updated_at"])
    elif turn.state != ChallengeTurn.State.SELECTING:
        raise ValidationError("当前挑战机会已经进入不可重新选择的阶段。")
    with authority_write(LIVE_CHALLENGE_STATE):
        _write_command(
            session=session,
            command_id=normalized_command,
            operation="challenge.turn.start",
            payload_hash=payload_hash,
            operator=current_operator,
            result_type="ChallengeTurn",
            result_id=turn.pk,
            result_payload={"turn_id": turn.pk, "sequence": turn.sequence},
        )
    _record_audit(
        operator=current_operator,
        action_type=AuditLog.ActionType.CHALLENGE_TURN_START,
        target=f"ChallengeTurn:{turn.pk}",
        new_value={"sequence": turn.sequence, "session_revision": session.revision},
    )
    turn.session = session
    return turn


@transaction.atomic
def record_challenge_target(
    session_id: int,
    *,
    seat_position: object,
    operator,
    command_id: object,
    expected_revision: object,
) -> ChallengeTurn:
    current_operator, session = _session_for_update(session_id, operator)
    normalized_command = _command_id(command_id)
    try:
        position = int(str(seat_position))
    except (TypeError, ValueError):
        raise ValidationError("挑战目标席位无效。") from None
    payload_hash = _hash_payload(
        {
            "operation": "challenge.target.record",
            "session_id": session.pk,
            "seat_position": position,
            "expected_revision": expected_revision,
        }
    )
    replay = _replay_command(
        session=session,
        command_id=normalized_command,
        operation="challenge.target.record",
        payload_hash=payload_hash,
        result_model=ChallengeTurn,
    )
    if replay is not None:
        return replay
    _check_revision(session, expected_revision)
    _ensure_session_dependencies_current(session)
    if session.state != ChallengeSession.State.ACTIVE:
        raise PermissionDenied("当前踢馆会话不在选人阶段。")
    turn = ChallengeTurn.objects.select_for_update().get(
        session=session, sequence=session.current_turn_number
    )
    if turn.state != ChallengeTurn.State.SELECTING:
        raise ValidationError("请先开始当前挑战者的选择。")
    seat = (
        ChallengeSeat.objects.select_for_update().filter(session=session, position=position).first()
    )
    if seat is None:
        raise ValidationError("挑战目标席位不存在。")
    if seat.is_challenged:
        raise ValidationError("席位已经被挑战，不能再次选择。")
    if seat.current_holder_id == turn.challenger_id:
        raise ValidationError("挑战者不能选择自己所在的席位。")
    turn.target_seat = seat
    turn.state = ChallengeTurn.State.TARGET_SELECTED
    turn.revision += 1
    turn.acted_by = current_operator
    turn.acted_at = timezone.now()
    _bump(session)
    with authority_write(LIVE_CHALLENGE_STATE):
        turn.save(update_fields=["target_seat", "state", "revision", "acted_by", "acted_at"])
        session.save(update_fields=["revision", "updated_at"])
        _write_command(
            session=session,
            command_id=normalized_command,
            operation="challenge.target.record",
            payload_hash=payload_hash,
            operator=current_operator,
            result_type="ChallengeTurn",
            result_id=turn.pk,
            result_payload={"turn_id": turn.pk, "seat_position": seat.position},
        )
    _record_audit(
        operator=current_operator,
        action_type=AuditLog.ActionType.CHALLENGE_TARGET_RECORD,
        target=f"ChallengeTurn:{turn.pk}",
        new_value={"seat_id": seat.pk, "seat_position": seat.position},
    )
    turn.session = session
    return turn


@transaction.atomic
def confirm_challenge_pairing(
    session_id: int,
    *,
    operator,
    command_id: object,
    expected_revision: object,
) -> ChallengeMatch:
    current_operator, session = _session_for_update(session_id, operator)
    normalized_command = _command_id(command_id)
    payload_hash = _hash_payload(
        {
            "operation": "challenge.pair.confirm",
            "session_id": session.pk,
            "expected_revision": expected_revision,
        }
    )
    replay = _replay_command(
        session=session,
        command_id=normalized_command,
        operation="challenge.pair.confirm",
        payload_hash=payload_hash,
        result_model=ChallengeMatch,
    )
    if replay is not None:
        return replay
    _check_revision(session, expected_revision)
    _ensure_session_dependencies_current(session)
    if session.state != ChallengeSession.State.ACTIVE:
        raise PermissionDenied("当前踢馆会话不可确认配对。")
    # PostgreSQL rejects FOR UPDATE on the nullable side of the outer join that
    # select_related() would generate for target_seat. The target is locked below
    # after the turn lock, so there is no need to join it into this query.
    turn = ChallengeTurn.objects.select_for_update().get(
        session=session, sequence=session.current_turn_number
    )
    if turn.state != ChallengeTurn.State.TARGET_SELECTED or turn.target_seat is None:
        raise ValidationError("请先记录挑战对象。")
    target_seat_id = turn.target_seat_id
    if target_seat_id is None:
        raise ValidationError("请先记录挑战对象。")
    seat = ChallengeSeat.objects.select_for_update().get(pk=target_seat_id)
    if seat.is_challenged:
        raise ValidationError("席位已经被挑战，不能重复确认配对。")
    now = timezone.now()
    with authority_write(LIVE_CHALLENGE_STATE):
        match = ChallengeMatch.objects.create(
            session=session,
            turn=turn,
            seat=seat,
            challenger=turn.challenger,
            defender=seat.current_holder,
            status=ChallengeMatch.Status.READY_FOR_SCORING,
            is_test_data=session.is_test_data,
        )
        seat.is_challenged = True
        seat.challenged_at = now
        seat.revision += 1
        seat.save(update_fields=["is_challenged", "challenged_at", "revision"])
        turn.state = ChallengeTurn.State.MATCHED
        turn.revision += 1
        turn.acted_by = current_operator
        turn.acted_at = now
        turn.save(update_fields=["state", "revision", "acted_by", "acted_at"])
        _bump(session)
        with authority_write(LIVE_CHALLENGE_STATE):
            session.save(update_fields=["revision", "updated_at"])
        _write_command(
            session=session,
            command_id=normalized_command,
            operation="challenge.pair.confirm",
            payload_hash=payload_hash,
            operator=current_operator,
            result_type="ChallengeMatch",
            result_id=match.pk,
            result_payload={
                "match_id": match.pk,
                "challenger_id": match.challenger_id,
                "defender_id": match.defender_id,
                "seat_position": seat.position,
            },
        )
    _record_audit(
        operator=current_operator,
        action_type=AuditLog.ActionType.CHALLENGE_PAIR_CONFIRM,
        target=f"ChallengeMatch:{match.pk}",
        new_value={
            "turn_id": turn.pk,
            "seat_id": seat.pk,
            "challenger_id": match.challenger_id,
            "defender_id": match.defender_id,
        },
    )
    match.session = session
    return match


@transaction.atomic
def waive_challenge_turn(
    session_id: int,
    *,
    operator,
    command_id: object,
    expected_revision: object,
    reason: str,
) -> ChallengeTurn:
    current_operator, session = _session_for_update(session_id, operator)
    normalized_command = _command_id(command_id)
    normalized_reason = str(reason or "").strip()
    if not normalized_reason:
        raise ValidationError("放弃挑战必须填写原因。")
    if len(normalized_reason) > 240:
        raise ValidationError("放弃挑战原因不能超过 240 个字符。")
    payload_hash = _hash_payload(
        {
            "operation": "challenge.turn.waive",
            "session_id": session.pk,
            "expected_revision": expected_revision,
            "reason": normalized_reason,
        }
    )
    replay = _replay_command(
        session=session,
        command_id=normalized_command,
        operation="challenge.turn.waive",
        payload_hash=payload_hash,
        result_model=ChallengeTurn,
    )
    if replay is not None:
        return replay
    _check_revision(session, expected_revision)
    _ensure_session_dependencies_current(session)
    if session.state != ChallengeSession.State.ACTIVE:
        raise PermissionDenied("当前踢馆会话不可放弃挑战。")
    turn = ChallengeTurn.objects.select_for_update().get(
        session=session, sequence=session.current_turn_number
    )
    if turn.state not in {
        ChallengeTurn.State.PENDING,
        ChallengeTurn.State.SELECTING,
        ChallengeTurn.State.TARGET_SELECTED,
    }:
        raise ValidationError("配对确认后不能正常放弃挑战。")
    turn.state = ChallengeTurn.State.WAIVED
    turn.target_seat = None
    turn.waive_reason = normalized_reason
    turn.revision += 1
    turn.acted_by = current_operator
    turn.acted_at = timezone.now()
    _finish_turn(session, turn)
    _bump(session)
    with authority_write(LIVE_CHALLENGE_STATE):
        turn.save(
            update_fields=[
                "state",
                "target_seat",
                "waive_reason",
                "revision",
                "acted_by",
                "acted_at",
            ]
        )
        session.save(update_fields=["state", "current_turn_number", "revision", "updated_at"])
        _write_command(
            session=session,
            command_id=normalized_command,
            operation="challenge.turn.waive",
            payload_hash=payload_hash,
            operator=current_operator,
            result_type="ChallengeTurn",
            result_id=turn.pk,
            result_payload={"turn_id": turn.pk, "sequence": turn.sequence},
        )
    _record_audit(
        operator=current_operator,
        action_type=AuditLog.ActionType.CHALLENGE_TURN_WAIVE,
        target=f"ChallengeTurn:{turn.pk}",
        new_value={
            "sequence": turn.sequence,
            "session_state": session.state,
            "reason": normalized_reason,
        },
    )
    turn.session = session
    return turn


@transaction.atomic
def prepare_challenge_match(
    session_id: int,
    *,
    operator,
    command_id: object,
    expected_revision: object,
) -> ChallengeMatch:
    """Create one two-contestant scoring round after pairing is confirmed."""

    current_operator, session = _session_for_update(session_id, operator)
    normalized_command = _command_id(command_id)
    payload_hash = _hash_payload(
        {
            "operation": "challenge.score.prepare",
            "session_id": session.pk,
            "expected_revision": expected_revision,
        }
    )
    replay = _replay_command(
        session=session,
        command_id=normalized_command,
        operation="challenge.score.prepare",
        payload_hash=payload_hash,
        result_model=ChallengeMatch,
    )
    if replay is not None:
        return replay
    _check_revision(session, expected_revision)
    _ensure_session_dependencies_current(session)
    match = (
        ChallengeMatch.objects.select_for_update()
        .select_related("turn", "seat", "challenger", "defender")
        .filter(session=session, turn__sequence=session.current_turn_number)
        .first()
    )
    if match is None:
        raise ValidationError("当前挑战机会还没有确认配对。")
    if match.status == ChallengeMatch.Status.SCORING and match.score_round_id:
        return match
    if match.status != ChallengeMatch.Status.READY_FOR_SCORING:
        raise ValidationError("当前比赛不在待准备评分阶段。")
    source_round = session.source_round
    live_config = (session.ruleset_version.binding or {}).get("live_challenge") or {}
    is_live_2026 = (
        isinstance(live_config, dict) and live_config.get("format_key") == LIVE_CHALLENGE_FORMAT_KEY
    )
    challenge_judges, minimum_judges = _configured_live_judges(
        session,
        ids_key="challenge_judge_ids",
        minimum_key="challenge_minimum_judge_count",
        label="挑战轮",
    )
    next_sequence = (
        ContestRound.objects.filter(activity=session.activity).aggregate(
            max_sequence=Max("sequence")
        )["max_sequence"]
        or 0
    ) + 1
    with authority_write(CONTEST_ROUND_STATE):
        score_round = ContestRound.objects.create(
            activity=session.activity,
            round_type=ContestRound.RoundType.SEMI_FINAL,
            scoring_mode=(
                ContestRound.ScoringMode.AVERAGE if is_live_2026 else source_round.scoring_mode
            ),
            score_completion_mode=ContestRound.CompletionMode.MINIMUM_VALID,
            judge_count=len(challenge_judges),
            minimum_judge_count=minimum_judges,
            name=f"踢馆第 {match.turn.sequence} 场评分",
            sequence=next_sequence,
            order_policy=ContestRound.OrderPolicy.MANUAL,
            advance_count=0,
            rubric=source_round.rubric,
            is_locked=False if hasattr(ContestRound, "is_locked") else False,
        )
        RoundEntry.objects.bulk_create(
            [
                RoundEntry(round=score_round, singer=match.challenger, running_order=1),
                RoundEntry(round=score_round, singer=match.defender, running_order=2),
            ]
        )
        RoundJudge.objects.bulk_create(
            [RoundJudge(round=score_round, judge=judge) for judge in challenge_judges]
        )
        Performance.objects.bulk_create(
            [
                Performance(
                    activity=session.activity,
                    round=score_round,
                    singer=match.challenger,
                    sequence=1,
                    song_title=questionnaire_song_for_key(
                        match.challenger, LIVE_PERSONAL_ROUNDS[0], default=""
                    ),
                    is_test_data=session.is_test_data,
                ),
                Performance(
                    activity=session.activity,
                    round=score_round,
                    singer=match.defender,
                    sequence=2,
                    song_title=questionnaire_song_for_key(
                        match.defender, LIVE_PERSONAL_ROUNDS[0], default=""
                    ),
                    is_test_data=session.is_test_data,
                ),
            ]
        )
        score_round.status = ContestRound.Status.PREPARED
        score_round.save(update_fields=["status", "is_locked"])
    # A prepared challenge round is immediately a live scoring surface. Creating the
    # panel here keeps the staff console's single "prepare" command atomic: no operator
    # can reach an open-challenger action while the round still lacks its judge snapshot.
    from .judge_authority import prepare_judge_panel

    # Link the round to its match *before* the panel is prepared. This round belongs to no
    # binding by design — the format binds the first round, and the challenge creates its
    # scoring rounds at the venue — so the execution-authority gate reads this link as the
    # round's provenance back to the authority that is running. The status changes after the
    # panel exists, as before, so an open-challenger action never reaches a round without one.
    match.score_round = score_round
    with authority_write(LIVE_CHALLENGE_STATE):
        match.save(update_fields=["score_round"])
    prepare_judge_panel(score_round.pk, operator=current_operator)
    match.status = ChallengeMatch.Status.SCORING
    match.revision += 1
    with authority_write(LIVE_CHALLENGE_STATE):
        match.save(update_fields=["status", "revision"])
        _bump(session)
        session.save(update_fields=["revision", "updated_at"])
        _write_command(
            session=session,
            command_id=normalized_command,
            operation="challenge.score.prepare",
            payload_hash=payload_hash,
            operator=current_operator,
            result_type="ChallengeMatch",
            result_id=match.pk,
            result_payload={"match_id": match.pk, "score_round_id": score_round.pk},
        )
    _record_audit(
        operator=current_operator,
        action_type=AuditLog.ActionType.CHALLENGE_SCORE_PREPARE,
        target=f"ChallengeMatch:{match.pk}",
        new_value={
            "score_round_id": score_round.pk,
            "contestants": [match.challenger_id, match.defender_id],
        },
    )
    match.session = session
    return match


@transaction.atomic
def lock_challenge_match_scores(
    session_id: int,
    *,
    operator,
    command_id: object,
    expected_revision: object,
) -> ChallengeMatch:
    """Close both individual performances only after each reaches the panel minimum."""

    current_operator, session = _session_for_update(session_id, operator)
    normalized_command = _command_id(command_id)
    payload_hash = _hash_payload(
        {
            "operation": "challenge.score.lock",
            "session_id": session.pk,
            "expected_revision": expected_revision,
        }
    )
    replay = _replay_command(
        session=session,
        command_id=normalized_command,
        operation="challenge.score.lock",
        payload_hash=payload_hash,
        result_model=ChallengeMatch,
    )
    if replay is not None:
        return replay
    _check_revision(session, expected_revision)
    _ensure_session_dependencies_current(session)
    match = (
        ChallengeMatch.objects.select_for_update()
        .filter(session=session, turn__sequence=session.current_turn_number)
        .first()
    )
    if match is None or match.score_round_id is None:
        raise ValidationError("当前比赛尚未准备评分。")
    if match.status != ChallengeMatch.Status.SCORING:
        raise ValidationError("当前比赛不在收分阶段。")
    score_round = ContestRound.objects.select_for_update().get(pk=match.score_round_id)
    performances = list(Performance.objects.filter(round=score_round).order_by("sequence", "pk"))
    states = list(
        PerformanceScoreState.objects.filter(performance__in=performances).values_list(
            "performance_id", "state"
        )
    )
    if len(performances) != 2 or len(states) != 2:
        raise ValidationError("踢馆比赛必须包含挑战者和守擂者两名评分对象。")
    if any(state != PerformanceScoreState.State.LOCKED for _, state in states):
        raise ValidationError("双方评分都必须先由工作人员分别锁定。")
    if score_round.status != ContestRound.Status.LOCKED:
        from .services import lock_round, recalculate_round

        # Direct judge submissions materialize ScoreRecord facts one judge at a time;
        # unlike the staff rapid-entry path they do not recalculate after each write.
        # Rebuild the official summaries before lock_round closes the dynamic round, so
        # confirm_challenge_match_result sees the same authority regardless of input path.
        recalculate_round(score_round)
        lock_round(score_round, current_operator)
    match.status = ChallengeMatch.Status.AWAITING_RESULT
    match.revision += 1
    with authority_write(LIVE_CHALLENGE_STATE):
        match.save(update_fields=["status", "revision"])
        _bump(session)
        session.save(update_fields=["revision", "updated_at"])
        _write_command(
            session=session,
            command_id=normalized_command,
            operation="challenge.score.lock",
            payload_hash=payload_hash,
            operator=current_operator,
            result_type="ChallengeMatch",
            result_id=match.pk,
            result_payload={"match_id": match.pk, "score_round_id": score_round.pk},
        )
    _record_audit(
        operator=current_operator,
        action_type=AuditLog.ActionType.CHALLENGE_SCORE_LOCK,
        target=f"ChallengeMatch:{match.pk}",
        new_value={"score_round_id": score_round.pk, "status": match.status},
    )
    match.session = session
    return match


@transaction.atomic
def confirm_challenge_match_result(
    session_id: int,
    *,
    operator,
    command_id: object,
    expected_revision: object,
) -> ChallengeMatch:
    """Compute the official weighted result and atomically replace the seat holder."""

    current_operator, session = _session_for_update(session_id, operator)
    normalized_command = _command_id(command_id)
    payload_hash = _hash_payload(
        {
            "operation": "challenge.match.confirm",
            "session_id": session.pk,
            "expected_revision": expected_revision,
        }
    )
    replay = _replay_command(
        session=session,
        command_id=normalized_command,
        operation="challenge.match.confirm",
        payload_hash=payload_hash,
        result_model=ChallengeMatch,
    )
    if replay is not None:
        return replay
    _check_revision(session, expected_revision)
    _ensure_session_dependencies_current(session)
    match = (
        ChallengeMatch.objects.select_for_update()
        .filter(session=session, turn__sequence=session.current_turn_number)
        .first()
    )
    if match is None or match.score_round_id is None:
        raise ValidationError("当前挑战比赛不存在评分结果。")
    if match.status != ChallengeMatch.Status.AWAITING_RESULT:
        raise ValidationError("当前挑战比赛尚未达到待确认胜负状态。")
    scores = {
        row.singer_id: row.average_score
        for row in ScoreSummary.objects.filter(
            round_id=match.score_round_id,
            singer_id__in=[match.challenger_id, match.defender_id],
        )
    }
    source_scores = {
        row.singer_id: row.average_score
        for row in ScoreSummary.objects.filter(
            round=session.source_round,
            singer_id__in=[match.challenger_id, match.defender_id],
        )
    }
    if set(scores) != {match.challenger_id, match.defender_id} or set(source_scores) != set(scores):
        raise ValidationError("挑战双方必须都有第一轮和本场已核定的正式成绩。")
    challenger_combined = official_weighted_score(
        [
            (source_scores[match.challenger_id], session.first_round_weight),
            (scores[match.challenger_id], session.challenge_round_weight),
        ]
    )
    defender_combined = official_weighted_score(
        [
            (source_scores[match.defender_id], session.first_round_weight),
            (scores[match.defender_id], session.challenge_round_weight),
        ]
    )
    if challenger_combined == defender_combined:
        raise ValidationError("实际综合成绩相同，不能自动确认胜负，请处理数据异常。")
    winner_id = (
        match.challenger_id if challenger_combined > defender_combined else match.defender_id
    )
    result_fp = _hash_payload(
        {
            "match_id": match.pk,
            "source_round_id": session.source_round_id,
            "score_round_id": match.score_round_id,
            "challenger_combined": str(challenger_combined),
            "defender_combined": str(defender_combined),
            "winner_id": winner_id,
        }
    )
    turn = ChallengeTurn.objects.select_for_update().get(pk=match.turn_id)
    seat = ChallengeSeat.objects.select_for_update().get(pk=match.seat_id)
    now = timezone.now()
    with authority_write(LIVE_CHALLENGE_STATE):
        match.status = ChallengeMatch.Status.CONFIRMED
        match.winner_id = winner_id
        match.challenger_first_score = quantize_official_score(source_scores[match.challenger_id])
        match.defender_first_score = quantize_official_score(source_scores[match.defender_id])
        match.challenger_second_score = quantize_official_score(scores[match.challenger_id])
        match.defender_second_score = quantize_official_score(scores[match.defender_id])
        match.challenger_combined_score = challenger_combined
        match.defender_combined_score = defender_combined
        match.result_fingerprint = result_fp
        match.confirmed_by = current_operator
        match.confirmed_at = now
        match.revision += 1
        match.save(
            update_fields=[
                "status",
                "winner",
                "challenger_first_score",
                "defender_first_score",
                "challenger_second_score",
                "defender_second_score",
                "challenger_combined_score",
                "defender_combined_score",
                "result_fingerprint",
                "confirmed_by",
                "confirmed_at",
                "revision",
            ]
        )
        seat.current_holder_id = winner_id
        seat.revision += 1
        seat.save(update_fields=["current_holder", "revision"])
        turn.state = ChallengeTurn.State.CONFIRMED
        turn.revision += 1
        turn.acted_by = current_operator
        turn.acted_at = now
        turn.save(update_fields=["state", "revision", "acted_by", "acted_at"])
        _finish_turn(session, turn)
        _bump(session)
        session.save(update_fields=["state", "current_turn_number", "revision", "updated_at"])
        _write_command(
            session=session,
            command_id=normalized_command,
            operation="challenge.match.confirm",
            payload_hash=payload_hash,
            operator=current_operator,
            result_type="ChallengeMatch",
            result_id=match.pk,
            result_payload={
                "match_id": match.pk,
                "winner_id": winner_id,
                "challenger_combined_score": str(challenger_combined),
                "defender_combined_score": str(defender_combined),
            },
        )
    _record_audit(
        operator=current_operator,
        action_type=AuditLog.ActionType.CHALLENGE_MATCH_CONFIRM,
        target=f"ChallengeMatch:{match.pk}",
        new_value={
            "winner_id": winner_id,
            "seat_id": seat.pk,
            "challenger_combined_score": str(challenger_combined),
            "defender_combined_score": str(defender_combined),
            "result_fingerprint": result_fp,
        },
    )
    match.session = session
    return match


@transaction.atomic
def confirm_challenge_session(
    session_id: int,
    *,
    operator,
    command_id: object,
    expected_revision: object,
) -> ChallengeSession:
    current_operator, session = _session_for_update(session_id, operator)
    normalized_command = _command_id(command_id)
    payload_hash = _hash_payload(
        {
            "operation": "challenge.session.confirm",
            "session_id": session.pk,
            "expected_revision": expected_revision,
        }
    )
    replay = _replay_command(
        session=session,
        command_id=normalized_command,
        operation="challenge.session.confirm",
        payload_hash=payload_hash,
        result_model=ChallengeSession,
    )
    if replay is not None:
        return replay
    _check_revision(session, expected_revision)
    _ensure_session_dependencies_current(session)
    counts = _live_counts(session.ruleset_version)
    if session.state != ChallengeSession.State.READY_TO_CONFIRM:
        raise ValidationError(f"{counts.challenge_count} 次踢馆机会尚未全部处理。")
    turns = list(ChallengeTurn.objects.filter(session=session).order_by("sequence"))
    if len(turns) != counts.challenge_count or any(
        turn.state not in {ChallengeTurn.State.WAIVED, ChallengeTurn.State.CONFIRMED}
        for turn in turns
    ):
        raise ValidationError(
            f"{counts.challenge_count} 次踢馆机会必须逐一处理后才能确认最终名单。"
        )
    seats = list(ChallengeSeat.objects.filter(session=session))
    holders = [seat.current_holder_id for seat in seats]
    if len(seats) != counts.seat_count or len(set(holders)) != counts.seat_count:
        raise ValidationError(f"最终名单必须恰好由 {counts.seat_count} 个不同席位持有人组成。")
    now = timezone.now()
    with authority_write(LIVE_CHALLENGE_STATE):
        session.state = ChallengeSession.State.CONFIRMED
        session.confirmed_by = current_operator
        session.confirmed_at = now
        session.revision += 1
        session.save(
            update_fields=["state", "confirmed_by", "confirmed_at", "revision", "updated_at"]
        )
        _write_command(
            session=session,
            command_id=normalized_command,
            operation="challenge.session.confirm",
            payload_hash=payload_hash,
            operator=current_operator,
            result_type="ChallengeSession",
            result_id=session.pk,
            result_payload={"session_id": session.pk, "holder_ids": holders},
        )
    _record_audit(
        operator=current_operator,
        action_type=AuditLog.ActionType.CHALLENGE_SESSION_CONFIRM,
        target=f"ChallengeSession:{session.pk}",
        new_value={
            "holder_ids": holders,
            "third_round_positions": [seat.third_round_position for seat in seats],
        },
    )
    return session


@transaction.atomic
def create_final_round_from_challenge(
    session_id: int,
    *,
    operator,
    command_id: object,
    expected_revision: object,
) -> ContestRound:
    """Materialize the confirmed ten-seat roster as the draft third round."""
    current_operator, session = _session_for_update(session_id, operator)
    normalized_command = _command_id(command_id)
    payload_hash = _hash_payload(
        {
            "operation": "challenge.final_round.prepare",
            "session_id": session.pk,
            "expected_revision": expected_revision,
        }
    )
    replay = _replay_command(
        session=session,
        command_id=normalized_command,
        operation="challenge.final_round.prepare",
        payload_hash=payload_hash,
        result_model=ContestRound,
    )
    if replay is not None:
        return replay
    _check_revision(session, expected_revision)
    _ensure_session_dependencies_current(session)
    if session.state != ChallengeSession.State.CONFIRMED:
        raise ValidationError("只有已确认最终十强后才能生成第三轮名单。")
    existing = ContestRound.objects.filter(
        roster_source=ContestRound.RosterSource.CHALLENGE_SESSION,
        roster_source_challenge_session=session,
    ).first()
    if existing is not None:
        raise ValidationError("第三轮名单已经生成，请从轮次页面继续准备。")
    roster = challenge_final_roster(session.pk, activity_id=session.activity_id)
    source_round = ContestRound.objects.select_for_update().get(pk=session.source_round_id)
    live_config = (session.ruleset_version.binding or {}).get("live_challenge") or {}
    is_live_2026 = (
        isinstance(live_config, dict) and live_config.get("format_key") == LIVE_CHALLENGE_FORMAT_KEY
    )
    final_judges, minimum_judges = _configured_live_judges(
        session,
        ids_key="final_judge_ids",
        minimum_key="final_minimum_judge_count",
        label="第三轮",
    )
    sequence = (
        ContestRound.objects.filter(activity=session.activity).aggregate(
            max_sequence=Max("sequence")
        )["max_sequence"]
        or 0
    ) + 1
    with authority_write(CONTEST_ROUND_STATE):
        final_round = ContestRound.objects.create(
            activity=session.activity,
            round_type=ContestRound.RoundType.SEMI_FINAL,
            scoring_mode=(
                ContestRound.ScoringMode.AVERAGE if is_live_2026 else source_round.scoring_mode
            ),
            score_completion_mode=ContestRound.CompletionMode.MINIMUM_VALID,
            judge_count=len(final_judges),
            minimum_judge_count=minimum_judges,
            name="第三轮冠军赛",
            sequence=sequence,
            # The challenge session's third_round_position is the frozen seat order.
            # Official numbers are only identity labels here; re-sorting by them would
            # move a challenger into the defender's seat after a successful challenge.
            order_policy=ContestRound.OrderPolicy.MANUAL,
            tie_order_policy=ContestRound.TieOrderPolicy.REVIEW,
            advance_count=0,
            roster_source=ContestRound.RosterSource.CHALLENGE_SESSION,
            roster_source_challenge_session=session,
            rubric=source_round.rubric,
        )
        RoundEntry.objects.bulk_create(
            [
                RoundEntry(round=final_round, singer=singer, running_order=index)
                for index, singer in enumerate(roster, start=1)
            ]
        )
        RoundJudge.objects.bulk_create(
            [RoundJudge(round=final_round, judge=judge) for judge in final_judges]
        )
        Performance.objects.bulk_create(
            [
                Performance(
                    activity=session.activity,
                    round=final_round,
                    singer=singer,
                    sequence=index,
                    song_title=questionnaire_song_for_key(
                        singer, LIVE_PERSONAL_ROUNDS[1], default=""
                    ),
                    is_test_data=session.is_test_data,
                )
                for index, singer in enumerate(roster, start=1)
            ]
        )
        # All snapshots are now materialized atomically.  Promote the round only after
        # the draft-only snapshot guards have accepted the complete roster/panel.
        final_round.status = ContestRound.Status.PREPARED
        final_round.save(update_fields=["status"])
        _bump(session)
        with authority_write(LIVE_CHALLENGE_STATE):
            session.save(update_fields=["revision", "updated_at"])
        _write_command(
            session=session,
            command_id=normalized_command,
            operation="challenge.final_round.prepare",
            payload_hash=payload_hash,
            operator=current_operator,
            result_type="ContestRound",
            result_id=final_round.pk,
            result_payload={
                "round_id": final_round.pk,
                "official_numbers": [singer.official_number for singer in roster],
            },
        )
    _record_audit(
        operator=current_operator,
        action_type=AuditLog.ActionType.CHALLENGE_FINAL_ROUND_PREPARE,
        target=f"ContestRound:{final_round.pk}",
        new_value={
            "challenge_session_id": session.pk,
            "official_numbers": [singer.official_number for singer in roster],
        },
    )
    return final_round
