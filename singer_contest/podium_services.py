"""Authoritative final podium computation for the live challenge flow."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from decimal import Decimal

from common.models import AuditLog
from core.policies import ActivityAction
from core.services import lock_activity_for_action
from django.core.exceptions import ValidationError
from django.db import transaction
from django.db.models import Max
from django.utils import timezone
from ruleset.live_format import live_challenge_counts_from_binding
from ruleset.models import RulesetVersion
from ruleset.resolver import (
    AwardDecision,
    CompositeResult,
    OutcomeCode,
    ResolveResult,
    ResolverState,
    StageDecision,
)

from .challenge_models import ChallengeSession
from .models import (
    ContestRound,
    Performance,
    PerformanceScoreState,
    ScoreSummary,
    StageResult,
)
from .scoring import official_weighted_score, quantize_official_score


@dataclass(frozen=True)
class PodiumConfig:
    stage_key: str
    first_round_key: str
    third_round_key: str
    aggregate_node: str
    first_weight: Decimal
    third_weight: Decimal
    #: 第一轮晋级数 / 初始席位数 — the third round holds exactly this many singers.
    seat_count: int


@dataclass(frozen=True)
class PodiumFacts:
    first_round: ContestRound
    third_round: ContestRound | None
    session: ChallengeSession | None
    first_scores: dict[int, Decimal]
    third_scores: dict[int, Decimal]
    fingerprint: str
    reasons: tuple[str, ...]


def _hash(payload: object) -> str:
    return hashlib.sha256(
        json.dumps(
            payload, ensure_ascii=True, sort_keys=True, separators=(",", ":"), default=str
        ).encode()
    ).hexdigest()


def podium_config(version: RulesetVersion) -> PodiumConfig:
    binding = version.binding or {}
    live = binding.get("live_challenge")
    if not isinstance(live, dict):
        raise ValidationError("冻结赛制尚未配置最终冠亚季军规则。")
    required = (
        "podium_stage_key",
        "podium_first_round_key",
        "podium_third_round_key",
        "podium_aggregate_node",
        "podium_first_round_weight",
        "podium_third_round_weight",
    )
    if any(not str(live.get(key) or "").strip() for key in required):
        raise ValidationError("冻结赛制的最终冠亚季军配置不完整。")
    try:
        first_weight = Decimal(str(live["podium_first_round_weight"]))
        third_weight = Decimal(str(live["podium_third_round_weight"]))
    except (KeyError, TypeError, ValueError):
        raise ValidationError("冻结赛制的最终冠亚季军权重无效。") from None
    if first_weight <= 0 or third_weight <= 0 or first_weight + third_weight != 1:
        raise ValidationError("最终冠亚季军权重必须合计 100%。")
    return PodiumConfig(
        stage_key=str(live["podium_stage_key"]).strip(),
        first_round_key=str(live["podium_first_round_key"]).strip(),
        third_round_key=str(live["podium_third_round_key"]).strip(),
        aggregate_node=str(live["podium_aggregate_node"]).strip(),
        first_weight=first_weight,
        third_weight=third_weight,
        seat_count=live_challenge_counts_from_binding(binding).seat_count,
    )


def _first_round(version: RulesetVersion, activity, config: PodiumConfig) -> ContestRound:
    round_id = (version.binding or {}).get("round_keys", {}).get(config.first_round_key)
    try:
        round_id = int(round_id)
    except (TypeError, ValueError):
        raise ValidationError("最终冠亚季军的第一轮绑定不存在。") from None
    first_round = ContestRound.objects.filter(pk=round_id, activity=activity).first()
    if first_round is None:
        raise ValidationError("最终冠亚季军的第一轮不属于当前活动。")
    return first_round


def podium_stage_key(version: RulesetVersion) -> str:
    return podium_config(version).stage_key


def podium_round_ids(version: RulesetVersion, activity) -> set[int]:
    """Return the physical rounds consumed by a confirmed podium result."""

    config = podium_config(version)
    first_round = _first_round(version, activity, config)
    session = (
        ChallengeSession.objects.filter(
            activity=activity,
            ruleset_version=version,
            state=ChallengeSession.State.CONFIRMED,
        )
        .order_by("-confirmed_at", "-pk")
        .first()
    )
    ids = {first_round.pk}
    if session is not None:
        final_round = (
            ContestRound.objects.filter(
                activity=activity,
                roster_source=ContestRound.RosterSource.CHALLENGE_SESSION,
                roster_source_challenge_session=session,
            )
            .order_by("-sequence", "-pk")
            .first()
        )
        if final_round is not None:
            ids.add(final_round.pk)
    return ids


def _facts(version: RulesetVersion, activity) -> PodiumFacts:
    config = podium_config(version)
    first_round = _first_round(version, activity, config)
    session = (
        ChallengeSession.objects.filter(
            activity=activity,
            ruleset_version=version,
            state=ChallengeSession.State.CONFIRMED,
        )
        .order_by("-confirmed_at", "-pk")
        .first()
    )
    third_round = None
    reasons: list[str] = []
    if session is None:
        reasons.append("podium_final_ten_not_confirmed")
    else:
        third_round = (
            ContestRound.objects.filter(
                activity=activity,
                roster_source=ContestRound.RosterSource.CHALLENGE_SESSION,
                roster_source_challenge_session=session,
            )
            .order_by("-sequence", "-pk")
            .first()
        )
        if third_round is None:
            reasons.append("podium_third_round_not_prepared")

    third_entries = list(third_round.entries.order_by("running_order", "pk")) if third_round else []
    holder_ids = (
        list(
            ChallengeSession.objects.filter(pk=session.pk)
            .values_list("seats__current_holder_id", flat=True)
            .distinct()
        )
        if session is not None
        else []
    )
    if session is not None and (
        len(third_entries) != config.seat_count
        or len(set(holder_ids)) != config.seat_count
        or {entry.singer_id for entry in third_entries} != set(holder_ids)
    ):
        reasons.append("podium_final_ten_roster_incomplete")
    if third_round is not None and third_round.status != ContestRound.Status.LOCKED:
        reasons.append("podium_third_round_not_locked")
    if first_round.status != ContestRound.Status.LOCKED or not first_round.is_locked:
        reasons.append("podium_first_round_not_locked")

    first_summaries = {
        row.singer_id: row.average_score for row in ScoreSummary.objects.filter(round=first_round)
    }
    third_summaries = (
        {row.singer_id: row.average_score for row in ScoreSummary.objects.filter(round=third_round)}
        if third_round is not None
        else {}
    )
    if session is not None:
        final_ids = [entry.singer_id for entry in third_entries]
        if any(singer_id not in first_summaries for singer_id in final_ids):
            reasons.append("podium_first_round_scores_incomplete")
        if third_round is not None and set(third_summaries) != set(final_ids):
            reasons.append("podium_third_round_scores_incomplete")
        if third_round is not None:
            performances = {
                performance.singer_id: performance
                for performance in Performance.objects.filter(round=third_round)
            }
            if set(performances) != set(final_ids) or len(performances) != config.seat_count:
                reasons.append("podium_third_round_performances_incomplete")
            elif (
                PerformanceScoreState.objects.filter(performance__in=performances.values())
                .exclude(state=PerformanceScoreState.State.LOCKED)
                .exists()
            ):
                reasons.append("podium_third_round_performances_unlocked")
            elif (
                PerformanceScoreState.objects.filter(performance__in=performances.values()).count()
                != config.seat_count
            ):
                reasons.append("podium_third_round_performances_unlocked")

    fingerprint = _hash(
        {
            "version": version.pk,
            "config": config.__dict__,
            "first_round": first_round.pk,
            "first_round_lock": first_round.is_locked,
            "session": session.pk if session else None,
            "session_revision": session.revision if session else None,
            "third_round": third_round.pk if third_round else None,
            "third_round_lock": third_round.is_locked if third_round else None,
            "first_scores": sorted((key, str(value)) for key, value in first_summaries.items()),
            "third_scores": sorted((key, str(value)) for key, value in third_summaries.items()),
            "entries": [(entry.singer_id, entry.running_order) for entry in third_entries],
        }
    )
    return PodiumFacts(
        first_round=first_round,
        third_round=third_round,
        session=session,
        first_scores=first_summaries,
        third_scores=third_summaries,
        fingerprint=fingerprint,
        reasons=tuple(dict.fromkeys(reasons)),
    )


def build_podium_result(version: RulesetVersion, activity) -> ResolveResult:
    """Compute the frozen weighted podium candidate without confirming it."""

    config = podium_config(version)
    facts = _facts(version, activity)
    if facts.reasons:
        return ResolveResult(
            status=ResolverState.HOLD,
            reasons=facts.reasons,
            input_fingerprint=facts.fingerprint,
            content_hash=_hash(config.__dict__),
            schema_version=1,
        )
    assert facts.third_round is not None
    final_entries = list(facts.third_round.entries.order_by("running_order", "pk"))
    rows = [
        (
            entry,
            official_weighted_score(
                [
                    (facts.first_scores[entry.singer_id], config.first_weight),
                    (facts.third_scores[entry.singer_id], config.third_weight),
                ]
            ),
        )
        for entry in final_entries
    ]
    ordered = sorted(rows, key=lambda item: (-item[1], item[0].running_order or 0, item[0].pk))
    has_tie = len({score for _, score in ordered}) != len(ordered)
    status = ResolverState.REVIEW if has_tie else ResolverState.READY
    reasons = ("podium_tie_requires_review",) if has_tie else ()
    decisions = tuple(
        StageDecision(
            contestant=str(entry.singer_id),
            outcome_code=OutcomeCode.FINALIST,
            source_node=config.aggregate_node,
            rank=index,
            score=score,
            reason="同分待人工核定" if has_tie else "",
            schema_version=1,
        )
        for index, (entry, score) in enumerate(ordered, start=1)
    )
    composites = tuple(
        CompositeResult(
            node_key=config.aggregate_node,
            contestant=str(entry.singer_id),
            value=score,
            components=(
                (
                    config.first_round_key,
                    config.first_weight,
                    quantize_official_score(facts.first_scores[entry.singer_id]),
                    quantize_official_score(
                        facts.first_scores[entry.singer_id] * config.first_weight
                    ),
                ),
                (
                    config.third_round_key,
                    config.third_weight,
                    quantize_official_score(facts.third_scores[entry.singer_id]),
                    quantize_official_score(
                        facts.third_scores[entry.singer_id] * config.third_weight
                    ),
                ),
            ),
        )
        for entry, score in ordered
    )
    awards = (
        tuple(
            AwardDecision(
                award=name,
                contestant=str(ordered[index][0].singer_id),
                score=ordered[index][1],
                source_node=config.aggregate_node,
            )
            for index, name in enumerate(("冠军", "亚军", "季军"))
        )
        if status == ResolverState.READY
        else ()
    )
    return ResolveResult(
        status=status,
        reasons=reasons,
        decisions=decisions,
        composites=composites,
        awards=awards,
        node_values={
            config.aggregate_node: {str(entry.singer_id): str(score) for entry, score in ordered}
        },
        content_hash=_hash(config.__dict__),
        input_fingerprint=facts.fingerprint,
        schema_version=1,
    )


def podium_current_input_fingerprint(version: RulesetVersion, activity) -> str:
    return _facts(version, activity).fingerprint


def podium_required_round_ids(version: RulesetVersion, activity) -> tuple[int, ...]:
    return tuple(sorted(podium_round_ids(version, activity)))


@transaction.atomic
def persist_podium_result(version: RulesetVersion, activity, *, computed_by):
    from .services import persist_stage_result

    result = build_podium_result(version, activity)
    config = podium_config(version)
    return persist_stage_result(
        version,
        activity,
        result,
        stage_key=config.stage_key,
        computed_by=computed_by,
    )


@transaction.atomic
def confirm_podium_result(stage: StageResult, *, confirmed_by):
    from accounts.services import require_current_staff
    from common.authority import STAGE_RESULT_CONFIRM, authority_write

    from .services import materialize_stage_awards

    current_actor = require_current_staff(confirmed_by)
    locked_activity = lock_activity_for_action(stage.activity, ActivityAction.PUBLISH_RESULT)
    locked = StageResult.objects.select_for_update().get(pk=stage.pk)
    version = RulesetVersion.objects.select_for_update().get(pk=locked.ruleset_version_id)
    config = podium_config(version)
    if locked.activity_id != locked_activity.pk or locked.stage_key != config.stage_key:
        raise ValidationError("赛段结果不是当前最终冠亚季军结果。")
    if version.status != RulesetVersion.Status.FROZEN or not version.is_current:
        raise ValidationError("只能核定基于当前冻结赛制版本生成的最终结果。")
    latest = StageResult.objects.filter(
        activity=locked.activity, stage_key=locked.stage_key
    ).aggregate(m=Max("result_version"))["m"]
    if locked.result_version != latest:
        raise ValidationError("该最终结果存在更新版本，请核定最新结果。")
    current = build_podium_result(version, locked.activity)
    if current.status != ResolverState.READY:
        raise ValidationError("最终冠亚季军结果尚未满足正式核定条件。")
    if locked.status == StageResult.Status.CONFIRMED:
        return locked
    if locked.status != StageResult.Status.READY_TO_CONFIRM:
        raise ValidationError("仅可核定已准备好的最终冠亚季军结果。")
    if locked.input_fingerprint != current.input_fingerprint:
        raise ValidationError("最终冠亚季军结果已过期，请重新计算。")
    locked.status = StageResult.Status.CONFIRMED
    locked.confirmed_by = current_actor
    locked.confirmed_at = timezone.now()
    with authority_write(STAGE_RESULT_CONFIRM):
        locked.save(update_fields=["status", "confirmed_by", "confirmed_at"])
    AuditLog.objects.create(
        operator=current_actor,
        action_type=AuditLog.ActionType.CONFIRM_STAGE_RESULT,
        target=f"StageResult:{locked.pk}",
        old_value=StageResult.Status.READY_TO_CONFIRM,
        new_value=json.dumps(
            {"status": StageResult.Status.CONFIRMED, "stage_key": locked.stage_key},
            ensure_ascii=False,
            sort_keys=True,
        ),
    )
    materialize_stage_awards(locked, operator=current_actor)
    return locked
