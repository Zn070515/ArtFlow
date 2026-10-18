"""Authoritative final podium computation for the live challenge flow."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from decimal import Decimal

from accounts.services import require_current_staff
from common.authority import PODIUM_TIE_DECISION, authority_write
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
from .challenge_services import _ensure_session_dependencies_current
from .models import (
    ContestRound,
    Performance,
    PerformanceScoreState,
    PodiumTieDecision,
    ScoreSummary,
    SingerRegistration,
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
        # The session froze the first-round authority it was played against. If a later
        # correction changes that source, recomputing with the new first-round scores and
        # the old challenge seats/queue would mix two authorities. Refuse instead.
        try:
            _ensure_session_dependencies_current(session, lock_dependencies=False)
        except ValidationError:
            reasons.append("podium_challenge_source_changed")
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


def _scored_rows(facts: PodiumFacts, config: PodiumConfig):
    """The final entries with their official weighted score, in default order."""

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
    return sorted(rows, key=lambda item: (-item[1], item[0].running_order or 0, item[0].pk))


def _score_groups(rows) -> dict[Decimal, list]:
    groups: dict[Decimal, list] = {}
    for entry, score in rows:
        groups.setdefault(score, []).append((entry, score))
    return groups


def _valid_tie_decisions(
    version: RulesetVersion, activity, config: PodiumConfig, fingerprint: str, groups
) -> dict[Decimal, list[int]]:
    """Manual orderings that still apply to *these* raw facts, keyed by score.

    A decision is usable only when it was made against the current fingerprint, covers
    exactly the current tied group, and is a permutation of it. Anything else leaves the
    group unresolved (REVIEW); the old row stays as audit history.
    """

    decisions = {
        decision.tie_score: decision
        for decision in PodiumTieDecision.objects.filter(
            activity_id=activity.pk,
            ruleset_version_id=version.pk,
            stage_key=config.stage_key,
            input_fingerprint=fingerprint,
        )
    }
    valid: dict[Decimal, list[int]] = {}
    for score, members in groups.items():
        if len(members) < 2:
            continue
        decision = decisions.get(score)
        if decision is None:
            continue
        group_ids = sorted(entry.singer_id for entry, _ in members)
        try:
            singer_ids = sorted(int(value) for value in (decision.singer_ids or []))
            ordering = [int(value) for value in (decision.ordering or [])]
        except (TypeError, ValueError):
            continue
        if (
            singer_ids == group_ids
            and sorted(ordering) == group_ids
            and len(set(ordering)) == len(ordering)
        ):
            valid[score] = ordering
    return valid


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
    rows = _scored_rows(facts, config)
    groups = _score_groups(rows)
    tie_scores = [score for score, members in groups.items() if len(members) > 1]
    valid = _valid_tie_decisions(version, activity, config, facts.fingerprint, groups)
    unresolved = [score for score in tie_scores if score not in valid]
    manual_positions: dict[int, int] = {}
    for score in tie_scores:
        for position, singer_id in enumerate(valid.get(score, ())):
            manual_positions[singer_id] = position
    ordered = sorted(
        rows,
        key=lambda item: (
            -item[1],
            manual_positions.get(item[0].singer_id, item[0].running_order or 0),
            item[0].pk,
        ),
    )
    status = ResolverState.REVIEW if unresolved else ResolverState.READY
    reasons = ("podium_tie_requires_review",) if unresolved else ()
    decisions = tuple(
        StageDecision(
            contestant=str(entry.singer_id),
            outcome_code=OutcomeCode.FINALIST,
            source_node=config.aggregate_node,
            rank=index,
            score=score,
            reason=(
                "同分待人工核定"
                if score in unresolved
                else "同分组经人工裁决"
                if score in tie_scores
                else ""
            ),
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


def podium_tie_groups(version: RulesetVersion, activity) -> list[dict]:
    """The equal-score groups an operator must order before the podium can be ready."""

    config = podium_config(version)
    facts = _facts(version, activity)
    if facts.reasons:
        return []
    rows = _scored_rows(facts, config)
    groups = _score_groups(rows)
    tie_scores = sorted(
        (score for score, members in groups.items() if len(members) > 1), reverse=True
    )
    if not tie_scores:
        return []
    valid = _valid_tie_decisions(version, activity, config, facts.fingerprint, groups)
    singer_ids = {entry.singer_id for members in groups.values() for entry, _ in members}
    names = {
        singer.pk: singer.name for singer in SingerRegistration.objects.filter(pk__in=singer_ids)
    }
    result: list[dict] = []
    for score in tie_scores:
        members = groups[score]
        if score in valid:
            by_id = {entry.singer_id: entry for entry, _ in members}
            ordered_entries = [by_id[singer_id] for singer_id in valid[score]]
        else:
            ordered_entries = [entry for entry, _ in members]
        result.append(
            {
                "score": score,
                "decided": score in valid,
                "singers": [
                    {
                        "id": entry.singer_id,
                        "name": names.get(entry.singer_id, str(entry.singer_id)),
                        "position": position,
                    }
                    for position, entry in enumerate(ordered_entries, start=1)
                ],
            }
        )
    return result


@transaction.atomic
def create_podium_tie_decision(
    stage: StageResult,
    *,
    ordering,
    reason: str,
    operator,
    base_input_fingerprint: str,
    base_candidate_revision: int | None = None,
):
    """Record and audit a manual ordering inside one equal-score podium group.

    Only the *group's internal* order is expressible: the caller's singer set must be
    exactly one current equal-score group, so a decision can never move a singer past
    someone with a different score. The decision is stored against the raw-facts
    fingerprint and the podium is recomputed immediately.
    """

    current_operator = require_current_staff(operator)
    reason = str(reason or "").strip()
    if not reason:
        raise ValidationError("必须说明人工裁决原因。")
    lock_activity_for_action(stage.activity, ActivityAction.PUBLISH_RESULT)
    locked = StageResult.objects.select_for_update().get(pk=stage.pk)
    version = RulesetVersion.objects.select_for_update().get(pk=locked.ruleset_version_id)
    config = podium_config(version)
    if locked.activity_id != stage.activity_id or locked.stage_key != config.stage_key:
        raise ValidationError("赛段结果不是当前最终冠亚季军结果。")
    if version.status != RulesetVersion.Status.FROZEN or not version.is_current:
        raise ValidationError("只能裁定基于当前冻结赛制版本生成的最终结果。")
    latest = StageResult.objects.filter(
        activity=locked.activity, stage_key=locked.stage_key
    ).aggregate(m=Max("result_version"))["m"]
    if locked.result_version != latest:
        raise ValidationError("该最终结果存在更新版本，请裁定最新结果。")
    if locked.status == StageResult.Status.CONFIRMED:
        raise ValidationError("已核定的最终结果不能再做人工裁决。")
    if base_candidate_revision is not None and locked.candidate_revision != base_candidate_revision:
        # The raw facts may be unchanged while another staff member already replaced the
        # candidate (a different tie ordering or a recompute). The page's baseline covers
        # both dimensions: facts via the fingerprint, candidate via this revision.
        raise ValidationError("候选结果已被其他工作人员更新，请刷新后重试。")
    facts = _facts(version, locked.activity)
    if facts.reasons:
        raise ValidationError("最终冠亚季军结果尚未满足正式裁决条件。")
    if not str(base_input_fingerprint or "").strip() or base_input_fingerprint != facts.fingerprint:
        raise ValidationError("最终结果已被更新，请刷新后重新计算。")

    try:
        singer_ids = [int(value) for value in ordering]
    except (TypeError, ValueError):
        raise ValidationError("人工裁决的选手顺序无效。") from None
    if len(singer_ids) < 2 or len(set(singer_ids)) != len(singer_ids):
        raise ValidationError("人工裁决必须为同分组内的全部选手给出唯一顺序。")
    rows = _scored_rows(facts, config)
    groups = _score_groups(rows)
    wanted = set(singer_ids)
    group = next(
        (
            members
            for members in groups.values()
            if len(members) > 1 and {entry.singer_id for entry, _ in members} == wanted
        ),
        None,
    )
    if group is None:
        raise ValidationError("人工裁决只能针对当前同分组内的全部选手。")
    tie_score = group[0][1]

    with authority_write(PODIUM_TIE_DECISION):
        decision = (
            PodiumTieDecision.objects.select_for_update()
            .filter(
                activity_id=locked.activity_id,
                ruleset_version_id=version.pk,
                stage_key=config.stage_key,
                tie_score=tie_score,
                input_fingerprint=facts.fingerprint,
            )
            .first()
        )
        old_value = ""
        if decision is None:
            decision = PodiumTieDecision(
                activity_id=locked.activity_id,
                ruleset_version=version,
                stage_key=config.stage_key,
                tie_score=tie_score,
                singer_ids=sorted(singer_ids),
                ordering=singer_ids,
                reason=reason,
                input_fingerprint=facts.fingerprint,
                is_test_data=locked.is_test_data,
                created_by=current_operator,
            )
        else:
            old_value = json.dumps(
                {"ordering": decision.ordering, "reason": decision.reason},
                ensure_ascii=False,
                sort_keys=True,
            )
            decision.singer_ids = sorted(singer_ids)
            decision.ordering = singer_ids
            decision.reason = reason
            decision.created_by = current_operator
        decision.save()

    AuditLog.objects.create(
        operator=current_operator,
        action_type=AuditLog.ActionType.MANUAL_DECISION,
        target=f"StageResult:{locked.pk}",
        old_value=old_value,
        new_value=json.dumps(
            {
                "tie_score": str(tie_score),
                "ordering": singer_ids,
                "reason": reason,
                "input_fingerprint": facts.fingerprint,
            },
            ensure_ascii=False,
            sort_keys=True,
        ),
        note="podium_tie_decision",
    )
    # The decision does not change raw facts, so the persisted candidate row is reused
    # and it is here that its REVIEW status becomes READY_TO_CONFIRM.
    persist_podium_result(version, locked.activity, computed_by=current_operator)
    return decision


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
def confirm_podium_result(
    stage: StageResult, *, confirmed_by, expected_candidate_revision: int | None = None
):
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
    if (
        expected_candidate_revision is not None
        and locked.candidate_revision != expected_candidate_revision
    ):
        # The operator must confirm the candidate they actually saw. A newer tie decision
        # leaves the raw fingerprint unchanged, so only this counter can catch it.
        raise ValidationError("候选结果已被其他工作人员更新，请刷新后重试。")
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
