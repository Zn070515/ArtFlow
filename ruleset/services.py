"""Freeze service for a DRAFT :class:`RulesetVersion` (§8.2, §16).

A ruleset becomes authoritative only through a *freeze*: the DRAFT version is
re-compiled, refused if the compiler reports any ERROR, and only then set to
``status=FROZEN`` with a frozen_by/frozen_at stamp and its execution plan
persisted. The bindings (round_keys / stage_key / announcement_blocks) are
snapshotted onto the version, so the frozen version is self-authoritative: the
runtime never re-reads the mutable ``ContestRuleset`` binding fields. The prior
current version (which is FROZEN) is demoted so the one-current partial unique
constraint holds and never violates the queryset's immutable guard — that demotion
goes through :class:`RulesetVersion._base_manager`.

The transaction is the only authority: admin does not require phase-gating (ruleset
config is set pre-contest), but requires the activity to be unlocked and the operator
to be an effective admin. Every freeze writes a :class:`~common.models.AuditLog`.
"""

from __future__ import annotations

import hashlib
import json
from copy import deepcopy
from dataclasses import replace
from decimal import Decimal, InvalidOperation
from typing import cast

from accounts.services import require_current_admin, require_current_staff
from common.authority import (
    CONTEST_ROUND_STATE,
    PLANNING_DRAFT_WRITE,
    RULESET_FREEZE,
    authority_write,
)
from common.models import AuditLog
from core.models import Activity
from core.services import lock_activity_for_action
from django.core.exceptions import PermissionDenied, ValidationError
from django.db import transaction
from django.utils import timezone
from questionnaire.compiler import QuestionnairePlan, compile_questionnaire
from questionnaire.cross_domain import (
    validate_questionnaire_context_keys,
    validate_questionnaire_rounds,
)
from questionnaire.schema import parse_questionnaire
from singer_contest.scoring import scoring_standard_snapshot

from .business_editor import business_definition_from_stages, infer_business_stages
from .compiler import ExecutionPlan, ReportIssue, Severity, ValidationReport, compile_definition
from .models import ContestRuleset, RulesetPlanningDraft, RulesetVersion
from .planning import (
    PlanningCompileResult,
    PlanningIssue,
    PlanningProjection,
    PlanningSeverity,
    default_planning_payload,
    planning_projection_from_definition,
    prepare_planning_compile,
    validate_planning_draft,
)
from .schema import ENTRY_KEY, content_hash, parse_definition
from .templates import (
    LIVE_2026_GROUP_COUNT,
    LIVE_2026_GROUP_SIZE,
)

LIVE_CHALLENGE_FORMAT_KEY = "2026_live_challenge"


class RulesetInvalidError(Exception):
    """The definition failed compilation; freezing must abort."""

    def __init__(self, report: ValidationReport, plan: ExecutionPlan | None):
        super().__init__("Ruleset definition is invalid; freeze aborted.")
        self.report = report
        self.plan = plan


def _demote_prior_current(version: RulesetVersion) -> None:
    """Drop the current flag from the previously-current FROZEN version.

    Uses the *base* manager (not the guarded ``objects`` manager) so the demotion
    does not trip the frozen-immutability guard — the demotion changes ``is_current``
    (which the immutable_fields list includes), so the queryset guard would otherwise
    raise. Only valid inside the freeze transaction.
    """
    RulesetVersion._base_manager.filter(ruleset_id=version.ruleset_id).exclude(
        pk=version.pk
    ).filter(is_current=True).update(is_current=False)


def _snapshot_binding(ruleset: ContestRuleset) -> dict:
    """Read the binding off a ruleset at freeze time (the editable input surface)."""
    snapshot = {
        "stage_key": ruleset.stage_key or "",
        "round_keys": dict(ruleset.round_keys or {}),
        "vote_keys": dict(ruleset.vote_keys or {}),
        "vote_scoring_rule_keys": dict(ruleset.vote_scoring_rule_keys or {}),
        "group_keys": dict(ruleset.group_keys or {}),
        "group_stage_keys": dict(ruleset.group_stage_keys or {}),
        "audience_keys": dict(ruleset.audience_keys or {}),
        "announcement_blocks": list(ruleset.announcement_blocks or []),
        "announcement_blocks_by_checkpoint": dict(ruleset.announcement_blocks_by_checkpoint or {}),
    }
    # Preserve the shape of legacy frozen bindings when this optional 2026 feature is not
    # configured; configured live events still carry the complete frozen contract.
    if ruleset.live_challenge:
        snapshot["live_challenge"] = dict(ruleset.live_challenge)
    return snapshot


def vote_scoring_binding_snapshot(rule_keys) -> dict:
    """The canonical frozen form of the ``{vote_source: rule pk}`` conversion binding.

    Freezing records the conversion's *identity and meaning* — rule id, mode and output
    scale — so a replay (and the staff verification panel) never has to ask the database
    which rule the session "has now". Refuses a rule that does not exist.
    """
    from voting.models import VoteScoringRule

    normalized = _normalize_pk_map(rule_keys, label="vote_scoring_rule_keys")
    if not normalized:
        return {}
    rules = {rule.pk: rule for rule in VoteScoringRule.objects.filter(pk__in=normalized.values())}
    snapshot: dict[str, dict] = {}
    for source, rule_pk in normalized.items():
        rule = rules.get(rule_pk)
        if rule is None:
            raise ValidationError(f"成绩换算规则不存在：{rule_pk}")
        snapshot[str(source)] = {
            "rule": rule.pk,
            "mode": rule.mode,
            "scale": rule.output_scale,
        }
    return snapshot


def _binding_signature(ruleset: ContestRuleset) -> str:
    """Canonical signature of a ruleset's editable binding surface.

    Used for stale-write detection in :func:`update_ruleset_binding`: a staff member's
    form carries the signature they loaded; if the committed surface changed since, the
    save is refused as a concurrent-edit conflict rather than silently overwriting.
    """
    return json.dumps(
        {
            "stage_key": ruleset.stage_key or "",
            "round_keys": dict(ruleset.round_keys or {}),
            "vote_keys": dict(ruleset.vote_keys or {}),
            "vote_scoring_rule_keys": dict(ruleset.vote_scoring_rule_keys or {}),
            "group_keys": dict(ruleset.group_keys or {}),
            "group_stage_keys": dict(ruleset.group_stage_keys or {}),
            "audience_keys": dict(ruleset.audience_keys or {}),
            "announcement_blocks": list(ruleset.announcement_blocks or []),
            "announcement_blocks_by_checkpoint": dict(
                ruleset.announcement_blocks_by_checkpoint or {}
            ),
            "live_challenge": dict(ruleset.live_challenge or {}),
        },
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )


_BUSINESS_ROUND_CONFIGURATION_FIELDS = (
    "name",
    "scoring_mode",
    "judge_count",
    "minimum_judge_count",
    "rubric_id",
    "advance_count",
    "roster_source",
    "roster_source_stage",
)


def _business_round_configuration_snapshot(rounds) -> dict[str, dict]:
    return {
        str(round_.pk): {
            field: getattr(round_, field) for field in _BUSINESS_ROUND_CONFIGURATION_FIELDS
        }
        for round_ in sorted(rounds, key=lambda item: item.pk)
    }


def business_round_configuration_signature(rounds) -> str:
    """Return the business editor's snapshot of activity round configuration."""
    snapshot = _business_round_configuration_snapshot(rounds)
    return json.dumps(snapshot, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _authority_hash(version: RulesetVersion) -> str:
    """Digest of the full authoritative surface (definition + frozen binding + plan).

    Unlike :func:`ruleset.schema.content_hash` (definition-only), this captures the
    freeze-time binding snapshot too, so two versions with identical definitions but
    different bindings hash differently. The StageResult audit identity uses it.
    """
    if version.execution_plan:
        try:
            plan_version = json.loads(version.execution_plan).get("plan_version", 0)
        except ValueError:
            plan_version = 0
    else:
        plan_version = 0
    digest = (
        content_hash(version.definition)
        + "|"
        + json.dumps(
            version.binding or {},
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        + "|"
        + str(plan_version)
    )
    return hashlib.sha256(digest.encode("utf-8")).hexdigest()


def _normalize_pk_map(raw, *, label):
    """Normalize a ``{str: int}`` binding map, rejecting malformed/empty ids."""
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        raise ValidationError(f"{label} 必须是 {{key: id}} 映射。")
    out: dict[str, int] = {}
    for key, rid in raw.items():
        if rid in ("", None):
            continue
        try:
            out[str(key)] = int(rid)
        except (TypeError, ValueError):
            raise ValidationError(f"{label}['{key}'] 必须是 id，got {rid!r}。")
    return out


def _normalize_string_map(raw, *, label):
    """Normalize a ``{str: str}`` binding map (e.g. audience_keys), rejecting empties."""
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        raise ValidationError(f"{label} 必须是 {{key: value}} 映射。")
    out: dict[str, str] = {}
    for key, value in raw.items():
        value = str(value).strip() if value is not None else ""
        if not value:
            continue
        out[str(key)] = value
    return out


def _weight_pair_percent(first_raw: object, second_raw: object) -> tuple[Decimal, Decimal]:
    """Parse a two-part weight pair given as percentages or as fractions.

    Editors submit ``"40%"`` / ``"60%"``; the normalized surface stores ``"0.4000"`` /
    ``"0.6000"``. Freeze re-validates whatever the surface holds, so both forms must parse —
    and mapping each to its percentage makes normalization idempotent.
    """

    first = Decimal(str(first_raw).strip().removesuffix("%").strip())
    second = Decimal(str(second_raw).strip().removesuffix("%").strip())
    if first <= 1 and second <= 1:
        return first * 100, second * 100
    return first, second


def validate_binding(
    ruleset: ContestRuleset,
    binding: dict | None,
    *,
    require_live_challenge_complete: bool = False,
) -> dict:
    """Normalize and validate a binding snapshot against the ruleset's activity.

    Only round/vote/group keys that resolve to a ``ContestRound`` / ``VoteSession`` /
    ``ContestRound`` owned by the same activity are accepted (a binding may only reference
    its own resources). Returns a normalized dict with ``{stage_key, round_keys, vote_keys,
    group_keys, announcement_blocks}``.
    """
    binding = dict(binding or {})
    normalized_round_keys = _normalize_pk_map(binding.get("round_keys"), label="round_keys")
    vote_keys = _normalize_pk_map(binding.get("vote_keys"), label="vote_keys")
    scoring_rule_keys = _normalize_pk_map(
        binding.get("vote_scoring_rule_keys"), label="vote_scoring_rule_keys"
    )
    group_keys = _normalize_pk_map(binding.get("group_keys"), label="group_keys")
    group_stage_keys = _normalize_pk_map(binding.get("group_stage_keys"), label="group_stage_keys")
    overlapping_group_keys = set(group_keys) & set(group_stage_keys)
    if overlapping_group_keys:
        raise ValidationError(
            f"同一个分组键不能同时绑定轮次分组和分组合唱赛段：{sorted(overlapping_group_keys)}"
        )
    audience_keys = _normalize_string_map(binding.get("audience_keys"), label="audience_keys")
    raw_live_challenge = binding.get("live_challenge") or {}
    if not isinstance(raw_live_challenge, dict):
        raise ValidationError("live_challenge 必须是对象。")
    live_format_key = str(raw_live_challenge.get("format_key") or "").strip()
    if live_format_key and live_format_key != LIVE_CHALLENGE_FORMAT_KEY:
        raise ValidationError("live_challenge.format_key 不是受支持的现场赛制类型。")
    strict_live_contract = (
        require_live_challenge_complete and live_format_key == LIVE_CHALLENGE_FORMAT_KEY
    )
    live_challenge: dict[str, object] = {}
    if raw_live_challenge:

        def _positive_int(key: str) -> int:
            try:
                value = int(str(raw_live_challenge.get(key)))
            except (TypeError, ValueError):
                raise ValidationError(f"live_challenge.{key} 必须是正整数。") from None
            if value <= 0:
                raise ValidationError(f"live_challenge.{key} 必须是正整数。")
            return value

        participant_count = _positive_int("participant_count")
        seat_count = _positive_int("seat_count")

        def _group_int(key: str, default: int) -> int:
            # Absent on bindings written before grouping became a parameter; falling back to
            # the built-in default keeps such a ruleset saveable until the operator changes it.
            raw = str(raw_live_challenge.get(key) or "").strip()
            if not raw:
                return default
            try:
                value = int(raw)
            except (TypeError, ValueError):
                raise ValidationError(f"live_challenge.{key} 必须是正整数。") from None
            if value <= 0:
                raise ValidationError(f"live_challenge.{key} 必须是正整数。")
            return value

        group_count = _group_int("group_count", LIVE_2026_GROUP_COUNT)
        group_size = _group_int("group_size", LIVE_2026_GROUP_SIZE)
        # 踢馆人数 is derived and never taken from the form: every singer who misses the
        # initial seats gets exactly one challenge opportunity, so the turn count *is* the
        # number of singers left over.
        challenge_count = participant_count - seat_count
        if participant_count <= seat_count:
            raise ValidationError("第一轮参赛人数必须大于第一轮晋级人数。")
        if group_count * group_size != participant_count:
            raise ValidationError("第一轮组数 × 每组人数必须等于第一轮参赛人数。")
        posted_challenge_count = str(raw_live_challenge.get("challenge_count") or "").strip()
        if posted_challenge_count and posted_challenge_count != str(challenge_count):
            raise ValidationError("踢馆人数必须等于第一轮参赛人数减第一轮晋级数，不能单独设置。")
        # Both branches below spread this: ``update_ruleset_binding`` persists exactly the dict
        # this function returns, so a key omitted from either branch is deleted on the next save.
        counts = {
            "participant_count": participant_count,
            "seat_count": seat_count,
            "challenge_count": challenge_count,
            "group_count": group_count,
            "group_size": group_size,
        }
        weight_keys = ("first_round_weight", "challenge_round_weight")
        absent_weights = [
            key for key in weight_keys if not str(raw_live_challenge.get(key) or "").strip()
        ]
        # The editable ruleset surface may keep an incomplete draft, exactly as the podium
        # and judge sections below already allow: the built-in 2026 format arrives carrying
        # the format's fixed keys and no ratios, because the ratios are the operators' to
        # choose. Freeze passes ``require_live_challenge_complete=True`` and rejects this
        # shape, so an unfilled pair can never reach a frozen version.
        if (
            len(absent_weights) == len(weight_keys)
            and live_format_key == (LIVE_CHALLENGE_FORMAT_KEY)
            and not strict_live_contract
        ):
            live_challenge = {**counts, "order_policy": "official_number"}
        else:
            if absent_weights:
                # Only reachable at freeze — the relaxed branch above covers a draft. An
                # unfilled pair is an incomplete configuration, not a malformed value, so it
                # reports as a sum failure rather than a format error.
                raise ValidationError("踢馆成绩权重必须合计 100%。")
            try:
                first_weight, challenge_weight = _weight_pair_percent(
                    raw_live_challenge.get("first_round_weight"),
                    raw_live_challenge.get("challenge_round_weight"),
                )
            except (InvalidOperation, TypeError, ValueError):
                raise ValidationError("踢馆成绩权重格式无效。") from None
            if first_weight <= 0 or challenge_weight <= 0 or first_weight + challenge_weight != 100:
                raise ValidationError("踢馆成绩权重必须合计 100%。")
            live_challenge = {
                **counts,
                "first_round_weight": f"{(first_weight / Decimal('100')):.4f}",
                "challenge_round_weight": f"{(challenge_weight / Decimal('100')):.4f}",
                "order_policy": "official_number",
            }
        if live_format_key:
            live_challenge["format_key"] = live_format_key
        podium_fields = {
            "podium_stage_key",
            "podium_first_round_key",
            "podium_third_round_key",
            "podium_aggregate_node",
            "podium_first_round_weight",
            "podium_third_round_weight",
        }
        podium_present = bool(podium_fields & set(raw_live_challenge))
        missing_podium = sorted(podium_fields - set(raw_live_challenge))
        if strict_live_contract and missing_podium:
            raise ValidationError("最终冠亚季军配置缺少字段：" + ", ".join(missing_podium))
        if podium_present and not missing_podium:
            podium_strings = {
                key: str(raw_live_challenge.get(key) or "").strip()
                for key in (
                    "podium_stage_key",
                    "podium_first_round_key",
                    "podium_third_round_key",
                    "podium_aggregate_node",
                )
            }
            if any(not value for value in podium_strings.values()):
                raise ValidationError("最终冠亚季军配置的键名不能为空。")
            if podium_strings["podium_first_round_key"] not in normalized_round_keys:
                raise ValidationError("最终冠亚季军的第一轮键必须绑定到 round_keys。")
            podium_weight_keys = ("podium_first_round_weight", "podium_third_round_weight")
            absent_podium_weights = [
                key
                for key in podium_weight_keys
                if not str(raw_live_challenge.get(key) or "").strip()
            ]
            # Same incomplete-draft allowance as the challenge weight pair above: the
            # built-in carries the podium *keys* — they are the format's identity — while the
            # two ratios stay the operators' choice.
            if (
                len(absent_podium_weights) == len(podium_weight_keys)
                and live_format_key == LIVE_CHALLENGE_FORMAT_KEY
                and not strict_live_contract
            ):
                live_challenge.update(podium_strings)
            else:
                if absent_podium_weights:
                    raise ValidationError("最终冠亚季军成绩权重必须合计 100%。")
                try:
                    podium_first, podium_third = _weight_pair_percent(
                        raw_live_challenge.get("podium_first_round_weight"),
                        raw_live_challenge.get("podium_third_round_weight"),
                    )
                except (InvalidOperation, TypeError, ValueError):
                    raise ValidationError("最终冠亚季军成绩权重格式无效。") from None
                if podium_first <= 0 or podium_third <= 0 or podium_first + podium_third != 100:
                    raise ValidationError("最终冠亚季军成绩权重必须合计 100%。")
                live_challenge.update(podium_strings)
                live_challenge.update(
                    {
                        "podium_first_round_weight": f"{(podium_first / Decimal('100')):.4f}",
                        "podium_third_round_weight": f"{(podium_third / Decimal('100')):.4f}",
                    }
                )
        elif podium_present:
            # The editable ruleset surface may keep an incomplete draft. Freeze uses
            # ``require_live_challenge_complete=True`` below and rejects this shape.
            live_challenge.update(
                {key: raw_live_challenge[key] for key in podium_fields if key in raw_live_challenge}
            )

        judge_config_fields = {
            "challenge_judge_ids",
            "challenge_minimum_judge_count",
            "final_judge_ids",
            "final_minimum_judge_count",
        }
        judges_present = bool(judge_config_fields & set(raw_live_challenge))
        missing_judges = sorted(judge_config_fields - set(raw_live_challenge))
        if strict_live_contract and missing_judges:
            raise ValidationError("现场轮次评委配置缺少字段：" + ", ".join(missing_judges))
        # "All four keys present, both lists empty" is a draft the operator has not filled in
        # yet — the same allowance the weight and podium sections make above. At freeze the
        # checks below still run and refuse it.
        judges_chosen = bool(
            raw_live_challenge.get("challenge_judge_ids")
            or raw_live_challenge.get("final_judge_ids")
        )
        if judges_present and not missing_judges and (judges_chosen or strict_live_contract):

            def _judge_ids(key: str) -> list[int]:
                raw_ids = raw_live_challenge.get(key)
                if not isinstance(raw_ids, (list, tuple)) or not raw_ids:
                    raise ValidationError(f"live_challenge.{key} 必须是非空评委 ID 列表。")
                try:
                    ids = [int(str(value)) for value in raw_ids]
                except (TypeError, ValueError):
                    raise ValidationError(f"live_challenge.{key} 含有无效评委 ID。") from None
                if any(value < 1 for value in ids) or len(ids) != len(set(ids)):
                    raise ValidationError(f"live_challenge.{key} 必须是正整数且不能重复。")
                return ids

            challenge_judge_ids = _judge_ids("challenge_judge_ids")
            final_judge_ids = _judge_ids("final_judge_ids")
            try:
                challenge_minimum = int(
                    str(raw_live_challenge.get("challenge_minimum_judge_count"))
                )
                final_minimum = int(str(raw_live_challenge.get("final_minimum_judge_count")))
            except (TypeError, ValueError):
                raise ValidationError("现场轮次最低有效评委数必须是正整数。") from None
            if not 1 <= challenge_minimum <= len(challenge_judge_ids):
                raise ValidationError("挑战轮最低有效评委数必须在挑战轮评委数范围内。")
            if not 1 <= final_minimum <= len(final_judge_ids):
                raise ValidationError("第三轮最低有效评委数必须在第三轮评委数范围内。")
            live_challenge.update(
                {
                    "challenge_judge_ids": challenge_judge_ids,
                    "challenge_minimum_judge_count": challenge_minimum,
                    "final_judge_ids": final_judge_ids,
                    "final_minimum_judge_count": final_minimum,
                }
            )
        elif judges_present:
            live_challenge.update(
                {
                    key: raw_live_challenge[key]
                    for key in judge_config_fields
                    if key in raw_live_challenge
                }
            )
        elif strict_live_contract:
            raise ValidationError(
                "现场轮次评委配置缺少字段：" + ", ".join(sorted(judge_config_fields))
            )
    announcement_blocks = binding.get("announcement_blocks") or []
    if not isinstance(announcement_blocks, list):
        raise ValidationError("announcement_blocks 必须是列表。")
    blocks_by_checkpoint = binding.get("announcement_blocks_by_checkpoint") or {}
    if not isinstance(blocks_by_checkpoint, dict):
        raise ValidationError(
            "announcement_blocks_by_checkpoint 必须是 {checkpoint: [blocks]} 映射。"
        )
    for cp_key, cp_blocks in blocks_by_checkpoint.items():
        if not isinstance(cp_blocks, list):
            raise ValidationError(f"announcement_blocks_by_checkpoint['{cp_key}'] 必须是列表。")

    from singer_contest.models import ContestRound, GroupStage, Judge
    from voting.models import VoteSession

    round_ids = list(normalized_round_keys.values())
    owned_rounds = {
        r.pk for r in ContestRound.objects.filter(pk__in=round_ids, activity=ruleset.activity_id)
    }
    missing_rounds = [rid for rid in round_ids if rid not in owned_rounds]
    if missing_rounds:
        raise ValidationError(f"赛制绑定的比赛轮次不属于该活动：{missing_rounds}")

    challenge_judge_ids = cast(list[int], live_challenge.get("challenge_judge_ids", []))
    final_judge_ids = cast(list[int], live_challenge.get("final_judge_ids", []))
    judge_ids: set[int] = set()
    judge_config_is_complete = {
        "challenge_judge_ids",
        "challenge_minimum_judge_count",
        "final_judge_ids",
        "final_minimum_judge_count",
    }.issubset(live_challenge)
    if judge_config_is_complete and isinstance(challenge_judge_ids, list):
        judge_ids.update(challenge_judge_ids)
    if judge_config_is_complete and isinstance(final_judge_ids, list):
        judge_ids.update(final_judge_ids)
    if judge_ids:
        owned_judges = {
            judge.pk
            for judge in Judge.objects.filter(
                pk__in=judge_ids,
                activity=ruleset.activity_id,
                is_active=True,
            )
        }
        missing_bound_judges = sorted(judge_ids - owned_judges)
        if missing_bound_judges:
            raise ValidationError(
                f"现场轮次评委不存在、未启用或不属于该活动：{missing_bound_judges}"
            )

    vote_ids = list(vote_keys.values())
    owned_votes = {
        v.pk for v in VoteSession.objects.filter(pk__in=vote_ids, activity=ruleset.activity_id)
    }
    missing_votes = [vid for vid in vote_ids if vid not in owned_votes]
    if missing_votes:
        raise ValidationError(f"赛制绑定的投票会话不属于该活动：{missing_votes}")

    group_ids = list(group_keys.values())
    owned_groups = {
        r.pk for r in ContestRound.objects.filter(pk__in=group_ids, activity=ruleset.activity_id)
    }
    missing_groups = [gid for gid in group_ids if gid not in owned_groups]
    if missing_groups:
        raise ValidationError(f"赛制绑定的分组成员轮次不属于该活动：{missing_groups}")

    group_stage_ids = list(group_stage_keys.values())
    owned_group_stages = {
        stage.pk
        for stage in GroupStage.objects.filter(
            pk__in=group_stage_ids,
            activity=ruleset.activity_id,
            status=GroupStage.Status.FROZEN,
        )
    }
    missing_group_stages = [
        stage_id for stage_id in group_stage_ids if stage_id not in owned_group_stages
    ]
    if missing_group_stages:
        raise ValidationError(
            f"赛制绑定的分组合唱赛段不存在、未冻结或不属于该活动：{missing_group_stages}"
        )

    # §6.1: a conversion rule is only meaningful for the vote source it converts, so the
    # binding must name an existing rule of exactly that bound session.
    if scoring_rule_keys:
        from voting.models import VoteScoringRule

        rules = {
            rule.pk: rule
            for rule in VoteScoringRule.objects.filter(pk__in=scoring_rule_keys.values())
        }
        for source, rule_pk in scoring_rule_keys.items():
            rule = rules.get(rule_pk)
            if rule is None:
                raise ValidationError(f"赛制绑定的成绩换算规则不存在：{rule_pk}")
            bound_session = vote_keys.get(source)
            if bound_session is None:
                raise ValidationError(f"成绩换算规则 {rule_pk} 未绑定对应的投票源 {source}。")
            if rule.vote_session_id != bound_session:
                raise ValidationError(f"成绩换算规则 {rule_pk} 不属于投票 {bound_session}。")

    # A source key must not bind as both a raw-count vote and a staff-entered audience
    # score: `_combined_vote_scores` would silently let audience overwrite the counts, and
    # `_stage_consumed_facts` already splits them — so reject the ambiguity at freeze time.
    overlap = set(vote_keys) & set(audience_keys)
    if overlap:
        raise ValidationError(f"观众分与投票键重复绑定：{sorted(overlap)}")

    normalized = {
        "stage_key": str(binding.get("stage_key") or "").strip(),
        "round_keys": normalized_round_keys,
        "vote_keys": vote_keys,
        "vote_scoring_rule_keys": scoring_rule_keys,
        "group_keys": group_keys,
        "group_stage_keys": group_stage_keys,
        "audience_keys": audience_keys,
        "announcement_blocks": announcement_blocks,
        "announcement_blocks_by_checkpoint": dict(blocks_by_checkpoint),
    }
    if live_challenge:
        normalized["live_challenge"] = live_challenge
    return normalized


def _lock_version_for_write(version: RulesetVersion) -> RulesetVersion:
    """Activity → ContestRuleset → RulesetVersion, re-reading the child under the lock.

    M0 lock-order: a child write must lock the Activity first, then re-read the owned
    aggregates, so a concurrent edit cannot operate over a stale in-memory object.
    """
    lock_activity_for_action(version.ruleset.activity)
    ContestRuleset.objects.select_for_update().get(pk=version.ruleset_id)
    return (
        RulesetVersion.objects.select_for_update()
        .select_related("ruleset__activity")
        .get(pk=version.pk)
    )


def _planning_payload_from_projection(
    projection: PlanningProjection,
) -> tuple[dict[str, object], str]:
    if projection.editable and projection.payload.get("stages"):
        return deepcopy(projection.payload), "historical_projection"
    return default_planning_payload(), "manual"


def _lock_planning_draft_version(
    version: RulesetVersion,
) -> tuple[RulesetVersion, RulesetPlanningDraft]:
    locked = _lock_version_for_write(version)
    draft = (
        RulesetPlanningDraft.objects.select_for_update()
        .filter(ruleset_version_id=locked.pk)
        .first()
    )
    if draft is not None:
        return locked, draft
    payload, source = _planning_payload_from_projection(
        planning_projection_from_definition(locked.definition)
    )
    with authority_write(PLANNING_DRAFT_WRITE):
        draft = RulesetPlanningDraft.objects.create(
            ruleset_version=locked,
            payload=payload,
            source=source,
        )
    return locked, draft


@transaction.atomic
def load_planning_draft(version: RulesetVersion) -> RulesetPlanningDraft:
    """Load or initialize the business draft under the standard aggregate lock order."""
    locked, draft = _lock_planning_draft_version(version)
    if locked.status != RulesetVersion.Status.DRAFT:
        raise PermissionDenied("已冻结赛制版本不可编辑规划草稿。")
    return draft


def read_planning_draft(version: RulesetVersion) -> tuple[dict[str, object], int]:
    """Read the planning surface without taking an editor lock or writing a draft.

    Frozen versions remain viewable. If no draft row exists, the lossless historical
    projection is still a valid read-only display payload and starts at revision zero.
    """
    draft = RulesetPlanningDraft.objects.filter(ruleset_version_id=version.pk).first()
    if draft is not None:
        return deepcopy(draft.payload), draft.revision
    payload, _source = _planning_payload_from_projection(
        planning_projection_from_definition(version.definition)
    )
    return payload, 0


@transaction.atomic
def save_planning_draft(
    version: RulesetVersion,
    *,
    payload: dict[str, object],
    operator,
    expected_revision: int,
) -> RulesetPlanningDraft:
    """Persist only business preparation data with compare-and-swap protection."""
    current_operator = require_current_staff(operator)
    locked, draft = _lock_planning_draft_version(version)
    if locked.status != RulesetVersion.Status.DRAFT:
        raise PermissionDenied("已冻结赛制版本不可编辑规划草稿。")
    if draft.revision != expected_revision:
        raise ValidationError("规划草稿已被其他编辑修改，请刷新后重试。")
    validate_planning_draft(payload)
    draft.payload = deepcopy(payload)
    draft.revision += 1
    draft.source = "manual"
    draft.updated_by = current_operator
    with authority_write(PLANNING_DRAFT_WRITE):
        draft.save(update_fields=["payload", "revision", "source", "updated_by", "updated_at"])
    AuditLog.objects.create(
        operator=current_operator,
        action_type=AuditLog.ActionType.UPDATE_RULESET_PLANNING,
        target=f"RulesetPlanningDraft:{draft.pk}",
        new_value=json.dumps(
            {"revision": draft.revision, "payload": draft.payload},
            ensure_ascii=False,
        ),
    )
    return draft


@transaction.atomic
def prepare_planning_compile_for_version(version: RulesetVersion) -> PlanningCompileResult:
    """Prepare a database-aware candidate from the current draft without mutation."""
    locked, draft = _lock_planning_draft_version(version)
    if locked.status != RulesetVersion.Status.DRAFT:
        raise PermissionDenied("已冻结赛制版本不可生成规划候选。")
    return prepare_planning_preflight(locked, draft.payload)


def _planning_rubric_scale(configuration: dict[str, object]) -> str | None:
    rubric = configuration.get("rubric")
    if not isinstance(rubric, dict):
        return None
    criteria = rubric.get("criteria")
    if not isinstance(criteria, list):
        return None
    total = Decimal("0")
    for criterion in criteria:
        if not isinstance(criterion, dict):
            return None
        try:
            total += Decimal(str(criterion.get("max_score")))
        except (TypeError, ValueError):
            return None
    return format(total.normalize(), "f") if total else None


def _planning_preflight_issue(code: str, message: str) -> PlanningIssue:
    return PlanningIssue(
        code=code,
        severity=PlanningSeverity.EXECUTION_RISK,
        message=message,
        blocks_apply=True,
    )


def prepare_planning_preflight(
    version: RulesetVersion, payload: dict[str, object]
) -> PlanningCompileResult:
    """Run business, binding, and bound-compiler checks without creating state.

    ``prepare_planning_compile`` remains a pure business conversion. This service adds the
    activity-owned checks that a preview and the apply command must agree on: existing round
    references are owned, editable, and current; audience sources are bound; and the candidate
    can be compiled with the facts already present in the database plus the explicit facts from
    the planning form. No rounds, rubrics, bindings, or draft rows are written here.
    """
    result = prepare_planning_compile(payload, version.definition)
    if not result.business_complete:
        return replace(result, binding_ready=False, freeze_ready=False)

    from singer_contest.models import ContestRound, ScoringRubric

    ruleset = ContestRuleset.objects.get(pk=version.ruleset_id)
    current_binding = _snapshot_binding(ruleset)
    current_round_keys = dict(current_binding.get("round_keys") or {})
    current_frozen_binding = (
        RulesetVersion._base_manager.filter(
            ruleset_id=version.ruleset_id,
            status=RulesetVersion.Status.FROZEN,
            is_current=True,
        )
        .values_list("binding", flat=True)
        .first()
    )
    frozen_round_ids = {
        int(round_id)
        for round_id in (
            current_frozen_binding.get("round_keys", {})
            if isinstance(current_frozen_binding, dict)
            else {}
        ).values()
        if str(round_id).isdigit() and int(round_id) > 0
    }
    raw_execution_refs = payload.get("execution_refs") or {}
    if not isinstance(raw_execution_refs, dict):
        return replace(
            result,
            issues=tuple(result.issues)
            + (
                _planning_preflight_issue(
                    "INVALID_EXECUTION_REFS", "规划草稿的执行引用必须是对象。"
                ),
            ),
            binding_ready=False,
            freeze_ready=False,
        )
    raw_round_refs = raw_execution_refs.get("rounds") or {}
    if not isinstance(raw_round_refs, dict):
        return replace(
            result,
            issues=tuple(result.issues)
            + (
                _planning_preflight_issue(
                    "INVALID_EXECUTION_REFS", "规划草稿的轮次执行引用必须是对象。"
                ),
            ),
            binding_ready=False,
            freeze_ready=False,
        )

    issues = list(result.issues)
    candidate_binding = deepcopy(current_binding)
    candidate_round_keys = dict(current_round_keys)
    binding_ready = True
    round_facts: dict[str, dict[str, object]] = {}
    for configuration in result.round_configurations:
        round_key = str(configuration["round_key"])
        raw_ref = raw_round_refs.get(round_key)
        if raw_ref is not None and not isinstance(raw_ref, dict):
            issues.append(
                _planning_preflight_issue(
                    "INVALID_EXECUTION_REFS", f"轮次“{round_key}”的执行引用必须是对象。"
                )
            )
            binding_ready = False
            continue
        if isinstance(raw_ref, dict) and raw_ref.get("round_key", round_key) != round_key:
            issues.append(
                _planning_preflight_issue(
                    "INVALID_EXECUTION_REFS", f"轮次“{round_key}”的执行引用标识不一致。"
                )
            )
            binding_ready = False
            continue
        ref_id = raw_ref.get("round_id") if isinstance(raw_ref, dict) else None
        mapped_id = current_round_keys.get(round_key)
        if (
            ref_id not in (None, "")
            and mapped_id not in (None, "")
            and str(ref_id) != str(mapped_id)
        ):
            issues.append(
                _planning_preflight_issue(
                    "STALE_EXECUTION_REF", f"轮次“{round_key}”的执行引用已过期，请刷新后重试。"
                )
            )
            binding_ready = False
        target_id = ref_id or mapped_id
        if target_id not in (None, ""):
            try:
                target_pk = int(str(target_id))
            except (TypeError, ValueError):
                target_pk = 0
            contest_round = (
                ContestRound.objects.select_related("rubric").filter(pk=target_pk).first()
                if target_pk > 0
                else None
            )
            if contest_round is not None and contest_round.activity_id != ruleset.activity_id:
                raise PermissionDenied("规划候选不能绑定其他活动的比赛轮次。")
            if contest_round is None:
                issues.append(
                    _planning_preflight_issue(
                        "ROUND_BINDING_INVALID", f"轮次“{round_key}”未绑定当前活动的比赛轮次。"
                    )
                )
                binding_ready = False
            else:
                if contest_round.status != ContestRound.Status.DRAFT or contest_round.is_locked:
                    issues.append(
                        _planning_preflight_issue(
                            "ROUND_NOT_EDITABLE",
                            f"轮次“{round_key}”已准备或锁定，不能由规划工作台修改。",
                        )
                    )
                    binding_ready = False
                if contest_round.pk in frozen_round_ids:
                    differences = _planning_round_configuration_diff_fields(
                        configuration, contest_round
                    )
                    for field in differences:
                        issues.append(
                            _planning_preflight_issue(
                                "FROZEN_ROUND_CONFIGURATION",
                                f"当前冻结赛制仍使用轮次“{round_key}”，不能修改其{field}配置。",
                            )
                        )
                    if differences:
                        binding_ready = False
                candidate_round_keys[round_key] = contest_round.pk
        rubric_id = raw_ref.get("rubric_id") if isinstance(raw_ref, dict) else None
        if rubric_id not in (None, ""):
            try:
                rubric_pk = int(str(rubric_id))
            except (TypeError, ValueError):
                rubric_pk = 0
            rubric = ScoringRubric.objects.filter(pk=rubric_pk).first() if rubric_pk > 0 else None
            if rubric is None:
                issues.append(
                    _planning_preflight_issue(
                        "RUBRIC_BINDING_INVALID", f"轮次“{round_key}”的评分标准引用不存在。"
                    )
                )
                binding_ready = False
            elif rubric.activity_id != ruleset.activity_id:
                raise PermissionDenied("规划候选不能绑定其他活动的评分标准。")
        configuration_facts: dict[str, object] = {}
        if "judge_count" in configuration:
            configuration_facts["judge_count"] = int(str(configuration["judge_count"]))
        scale = _planning_rubric_scale(configuration)
        if scale is not None:
            configuration_facts["scale"] = scale
        round_facts[round_key] = configuration_facts

    candidate_binding["round_keys"] = candidate_round_keys
    for stage in result.business_stages:
        try:
            audience_weight = Decimal(str(stage.get("audience_weight") or "0"))
        except (TypeError, ValueError):
            audience_weight = Decimal("0")
        vote_source = str(stage.get("vote_source") or "")
        if audience_weight and vote_source not in {
            *dict(current_binding.get("vote_keys") or {}),
            *dict(current_binding.get("audience_keys") or {}),
        }:
            issues.append(
                _planning_preflight_issue(
                    "MISSING_VOTE_BINDING",
                    f"观众成绩来源“{vote_source}”尚未绑定到当前活动。",
                )
            )
            binding_ready = False

    context = build_bound_context(version, candidate_binding)
    context_rounds = context.setdefault("rounds", {})
    if isinstance(context_rounds, dict):
        for round_key, facts in round_facts.items():
            existing_facts = context_rounds.get(round_key)
            merged = dict(existing_facts) if isinstance(existing_facts, dict) else {}
            merged.update(facts)
            context_rounds[round_key] = merged
    context_votes = context.get("votes") or {}
    bound_vote_keys = dict(current_binding.get("vote_keys") or {})
    bound_audience_keys = dict(current_binding.get("audience_keys") or {})
    for stage in result.business_stages:
        try:
            audience_weight = Decimal(str(stage.get("audience_weight") or "0"))
        except (TypeError, ValueError):
            audience_weight = Decimal("0")
        if not audience_weight:
            continue
        vote_source = str(stage.get("vote_source") or "")
        declared_conversion = str(stage.get("audience_conversion") or "")
        if vote_source in bound_vote_keys:
            vote_facts = context_votes.get(vote_source) if isinstance(context_votes, dict) else None
            expected_conversion = (
                vote_facts.get("conversion") if isinstance(vote_facts, dict) else None
            )
            if not expected_conversion:
                issues.append(
                    _planning_preflight_issue(
                        "MISSING_VOTE_CONVERSION",
                        f"投票来源“{vote_source}”尚未绑定成绩换算规则。",
                    )
                )
                binding_ready = False
            elif declared_conversion != expected_conversion:
                issues.append(
                    _planning_preflight_issue(
                        "VOTE_CONVERSION_MISMATCH",
                        f"投票来源“{vote_source}”的换算方式与活动绑定不一致。",
                    )
                )
                binding_ready = False
        elif vote_source in bound_audience_keys and declared_conversion != "audience_score_hundred":
            issues.append(
                _planning_preflight_issue(
                    "VOTE_CONVERSION_MISMATCH",
                    f"观众分来源“{vote_source}”必须声明百分制观众分换算。",
                )
            )
            binding_ready = False
    formal_ready = False
    if binding_ready and result.candidate_definition is not None:
        report, _plan = compile_definition(
            result.candidate_definition,
            context=context,
            bound=True,
        )
        formal_ready = report.passes()
        if not formal_ready:
            first_error = next(
                (issue.message for issue in report.issues if issue.severity is Severity.ERROR),
                "正式冻结检查未通过。",
            )
            issues.append(
                PlanningIssue(
                    code="FORMAL_FREEZE_NOT_READY",
                    severity=PlanningSeverity.EXECUTION_RISK,
                    message=first_error,
                    blocks_apply=False,
                )
            )
    return replace(
        result,
        issues=tuple(issues),
        binding_ready=binding_ready,
        freeze_ready=formal_ready,
    )


def _raise_planning_compile_blocked(result: PlanningCompileResult) -> None:
    messages = [issue.message or issue.code for issue in result.issues if issue.blocks_apply]
    if messages:
        raise ValidationError(messages)
    raise ValidationError("规划候选无法应用。")


def _planning_rubric_matches(rubric, raw_rubric: dict[str, object]) -> bool:
    try:
        raw_criteria = raw_rubric.get("criteria")
        criteria = raw_criteria if isinstance(raw_criteria, list) else []
        expected_criteria = [
            {
                "name": str(item.get("name") or "").strip(),
                "max_score": Decimal(str(item.get("max_score"))),
                "description": str(item.get("description") or "").strip(),
            }
            for item in criteria
            if isinstance(item, dict)
        ]
    except (InvalidOperation, TypeError, ValueError):
        return False
    actual_criteria = [
        {
            "name": criterion.name,
            "max_score": criterion.max_score,
            "description": criterion.description,
        }
        for criterion in rubric.criteria.all().order_by("sequence", "pk")
    ]
    return (
        rubric.name == str(raw_rubric.get("name") or "").strip()
        and rubric.description == str(raw_rubric.get("description") or "").strip()
        and actual_criteria == expected_criteria
    )


def _planning_round_configuration_diff_fields(
    configuration: dict[str, object], contest_round
) -> tuple[str, ...]:
    differences: list[str] = []
    for field in (
        "name",
        "scoring_mode",
        "advance_count",
        "roster_source",
        "roster_source_stage",
        "judge_count",
        "minimum_judge_count",
    ):
        if field in configuration and getattr(contest_round, field) != configuration[field]:
            differences.append(field)
    if "rubric" in configuration:
        raw_rubric = configuration["rubric"]
        actual_rubric = getattr(contest_round, "rubric", None)
        rubric_matches = (raw_rubric is None and actual_rubric is None) or (
            isinstance(raw_rubric, dict)
            and actual_rubric is not None
            and _planning_rubric_matches(actual_rubric, raw_rubric)
        )
        if not rubric_matches:
            differences.append("rubric")
    return tuple(differences)


@transaction.atomic
def apply_planning_to_ruleset(
    version: RulesetVersion,
    *,
    operator,
    expected_revision: int,
) -> RulesetVersion:
    """Apply one complete planning candidate through the existing ruleset service."""
    current_operator = require_current_staff(operator)
    locked, draft = _lock_planning_draft_version(version)
    if locked.status != RulesetVersion.Status.DRAFT:
        raise PermissionDenied("已冻结赛制版本不可应用规划候选。")
    if draft.revision != expected_revision:
        raise ValidationError("规划草稿已被其他编辑修改，请刷新后重试。")
    result = prepare_planning_preflight(locked, draft.payload)
    if not result.safe_to_apply:
        _raise_planning_compile_blocked(result)

    from singer_contest.models import ContestRound, ScoringRubric
    from singer_contest.services import (
        configure_draft_round_from_planning,
        create_scoring_rubric,
    )

    locked_ruleset = ContestRuleset.objects.select_for_update().get(pk=locked.ruleset_id)
    base_binding = _binding_signature(locked_ruleset)
    existing_round_keys = dict(locked_ruleset.round_keys or {})
    raw_execution_refs = draft.payload.get("execution_refs")
    if raw_execution_refs in (None, {}):
        raw_execution_refs = {}
    if not isinstance(raw_execution_refs, dict):
        raise ValidationError("规划草稿的执行引用必须是对象。")
    raw_round_refs = raw_execution_refs.get("rounds", {})
    if not isinstance(raw_round_refs, dict):
        raise ValidationError("规划草稿的轮次执行引用必须是对象。")
    validated_round_ids: dict[str, int] = {}
    for configuration in result.round_configurations:
        round_key = str(configuration["round_key"])
        raw_ref = raw_round_refs.get(round_key)
        if raw_ref is None:
            continue
        if not isinstance(raw_ref, dict):
            raise ValidationError(f"轮次“{round_key}”的执行引用必须是对象。")
        if raw_ref.get("round_key", round_key) != round_key:
            raise ValidationError(f"轮次“{round_key}”的执行引用标识不一致。")
        raw_round_id = raw_ref.get("round_id")
        if raw_round_id in (None, ""):
            continue
        try:
            round_id = int(str(raw_round_id))
        except (TypeError, ValueError) as exc:
            raise ValidationError(f"轮次“{round_key}”的执行引用 id 无效。") from exc
        if round_id <= 0:
            raise ValidationError(f"轮次“{round_key}”的执行引用 id 无效。")
        contest_round = (
            ContestRound.objects.select_for_update()
            .select_related("activity")
            .filter(pk=round_id)
            .first()
        )
        if contest_round is None:
            raise ValidationError(f"轮次“{round_key}”的执行引用不存在。")
        if contest_round.activity_id != locked_ruleset.activity_id:
            raise PermissionDenied("规划候选不能绑定其他活动的比赛轮次。")
        mapped_id = existing_round_keys.get(round_key)
        if mapped_id not in (None, "") and str(mapped_id) != str(round_id):
            raise ValidationError(f"轮次“{round_key}”的执行引用已过期，请刷新后重试。")
        validated_round_ids[round_key] = round_id

    round_by_key: dict[str, ContestRound] = {}
    execution_refs = deepcopy(raw_execution_refs)
    execution_round_refs = execution_refs.setdefault("rounds", {})
    if not isinstance(execution_round_refs, dict):
        raise ValidationError("规划草稿的轮次执行引用必须是对象。")
    for configuration in result.round_configurations:
        round_key = str(configuration["round_key"])
        raw_round_id = validated_round_ids.get(round_key, existing_round_keys.get(round_key))
        if raw_round_id not in (None, ""):
            try:
                round_id = int(str(raw_round_id))
            except (TypeError, ValueError) as exc:
                raise ValidationError(f"轮次“{round_key}”的绑定 id 无效。") from exc
            contest_round = (
                ContestRound.objects.select_for_update().select_related("activity").get(pk=round_id)
            )
            if contest_round.activity_id != locked_ruleset.activity_id:
                raise PermissionDenied("规划候选不能绑定其他活动的比赛轮次。")
        else:
            round_type = (
                ContestRound.RoundType.PRELIMINARY
                if int(str(configuration["stage_index"])) == 1
                else ContestRound.RoundType.SEMI_FINAL
            )
            with authority_write(CONTEST_ROUND_STATE):
                contest_round = ContestRound.objects.create(
                    activity_id=locked_ruleset.activity_id,
                    round_type=round_type,
                    scoring_mode=str(configuration["scoring_mode"]),
                    name=str(configuration["name"]),
                    advance_count=int(str(configuration["advance_count"])),
                    roster_source=str(configuration["roster_source"]),
                    roster_source_stage=str(configuration["roster_source_stage"]),
                )
        configuration_kwargs: dict[str, object] = {
            "name": str(configuration["name"]),
            "scoring_mode": str(configuration["scoring_mode"]),
            "advance_count": int(str(configuration["advance_count"])),
            "roster_source": str(configuration["roster_source"]),
            "roster_source_stage": str(configuration["roster_source_stage"]),
        }
        for field in ("judge_count", "minimum_judge_count"):
            if field in configuration:
                configuration_kwargs[field] = configuration[field]
        if "rubric" in configuration:
            raw_rubric = configuration["rubric"]
            if raw_rubric is None or not isinstance(raw_rubric, dict):
                raise ValidationError("规划候选的评分标准无效。")
            raw_ref = raw_round_refs.get(round_key)
            raw_rubric_id = raw_ref.get("rubric_id") if isinstance(raw_ref, dict) else None
            if raw_rubric_id not in (None, ""):
                try:
                    rubric_id = int(str(raw_rubric_id))
                except (TypeError, ValueError) as exc:
                    raise ValidationError(f"轮次“{round_key}”的评分标准引用无效。") from exc
                rubric = ScoringRubric.objects.select_for_update().filter(pk=rubric_id).first()
                if rubric is None:
                    raise ValidationError(f"轮次“{round_key}”的评分标准引用不存在。")
                if rubric.activity_id != locked_ruleset.activity_id:
                    raise PermissionDenied("规划候选不能绑定其他活动的评分标准。")
                if not _planning_rubric_matches(rubric, raw_rubric):
                    rubric = None
            else:
                rubric = None
            if rubric is None and contest_round.rubric_id:
                existing_rubric = (
                    ScoringRubric.objects.select_for_update()
                    .filter(pk=contest_round.rubric_id, activity_id=locked_ruleset.activity_id)
                    .first()
                )
                if existing_rubric is not None and _planning_rubric_matches(
                    existing_rubric, raw_rubric
                ):
                    rubric = existing_rubric
            if rubric is None:
                rubric = create_scoring_rubric(
                    locked_ruleset.activity,
                    name=raw_rubric.get("name"),
                    description=raw_rubric.get("description", ""),
                    criteria=raw_rubric.get("criteria"),
                    operator=current_operator,
                    planning=True,
                )
            configuration_kwargs["rubric"] = rubric
        configured = configure_draft_round_from_planning(
            contest_round,
            operator=current_operator,
            configuration=configuration_kwargs,
        )
        round_by_key[round_key] = configured
        raw_business_ids = configuration.get("business_ids")
        business_ids = raw_business_ids if isinstance(raw_business_ids, list) else []
        execution_round_refs[round_key] = {
            "round_key": round_key,
            "round_id": configured.pk,
            "business_ids": list(business_ids),
            "rubric_id": configured.rubric_id,
        }

    stages = deepcopy(list(result.business_stages))
    for stage in stages:
        raw_sources = stage.get("judge_sources")
        if not isinstance(raw_sources, list):
            continue
        for source in raw_sources:
            if not isinstance(source, dict):
                continue
            round_key = str(source.get("round_key") or "")
            configured_round = round_by_key.get(round_key)
            if configured_round is None:
                raise ValidationError("规划候选缺少可执行的比赛轮次。")
            source["round_id"] = configured_round.pk
            source["create_round"] = False

    base_round_configuration = business_round_configuration_signature(
        ContestRound.objects.filter(activity_id=locked_ruleset.activity_id)
    )
    saved = save_business_ruleset(
        locked,
        stages=stages,
        operator=current_operator,
        base_content_hash=locked.content_hash,
        base_binding=base_binding,
        base_round_configuration=base_round_configuration,
    )
    updated_payload = deepcopy(draft.payload)
    updated_payload["execution_refs"] = execution_refs
    draft.payload = updated_payload
    with authority_write(PLANNING_DRAFT_WRITE):
        draft.save(update_fields=["payload", "updated_at"])
    AuditLog.objects.create(
        operator=current_operator,
        action_type=AuditLog.ActionType.UPDATE_RULESET_PLANNING,
        target=f"RulesetPlanningDraft:{draft.pk}",
        new_value=json.dumps(
            {"revision": draft.revision, "applied": True, "execution_refs": execution_refs},
            ensure_ascii=False,
        ),
        note="apply_planning_to_ruleset",
    )
    return saved


@transaction.atomic
def update_ruleset_definition(
    version: RulesetVersion, *, definition: str, operator, base_content_hash: str | None = None
) -> RulesetVersion:
    """Persist a Draft definition edit under the Activity-first lock.

    Re-reads the version after locking (a second staff member's concurrent save cannot be
    silently overwritten), refuses a write to a FROZEN version, and — when
    ``base_content_hash`` is supplied — rejects a save whose editor started from a stale
    definition (the 409-contract for concurrent editing). Returns the locked version.
    """
    require_current_staff(operator)
    locked = _lock_version_for_write(version)
    if locked.status == RulesetVersion.Status.FROZEN:
        raise PermissionDenied("已冻结赛制版本不可编辑。")
    if base_content_hash is not None and locked.content_hash != base_content_hash:
        raise ValidationError("赛制已被其他编辑修改，请刷新后重试。")
    parse_definition(definition)
    locked.definition = definition
    locked.save(update_fields=["definition"])
    return locked


# The definition root's operator-editable sections. Each editor owns exactly one of them;
# replacing the whole document is reserved for the advanced JSON editor, which goes through
# ``update_ruleset_definition``.
DEFINITION_SECTIONS: tuple[str, ...] = ("nodes", "checkpoints", "context", "questionnaire")


@transaction.atomic
def update_ruleset_definition_sections(
    version: RulesetVersion,
    *,
    sections: dict[str, object],
    operator,
    base_content_hash: str | None = None,
    allow_empty_checkpoints: bool = False,
) -> RulesetVersion:
    """Replace several top-level ``definition`` sections in one atomic root update.

    The root is a document, not a node list: ``checkpoints`` and ``context`` are already
    written beside ``nodes``, and the Ruleset-driven Questionnaire phase adds
    ``questionnaire`` next to them. Editors can own different sections, but a business
    editor must be able to save its complete form as one document update so a failed
    validation cannot leave half of the form committed.

    The version is re-read under the Activity-first lock, so the patch applies to the root
    as it exists at write time rather than to a document the caller loaded earlier.
    ``base_content_hash`` carries the same stale-editor contract as
    :func:`update_ruleset_definition`, and the complete document is re-validated before the
    save, so a section patch can never persist a graph that ``parse_definition`` rejects.
    """
    require_current_staff(operator)
    if not isinstance(sections, dict) or not sections:
        raise ValidationError("至少需要提交一个 definition section。")
    unknown = sorted(set(sections) - set(DEFINITION_SECTIONS))
    if unknown:
        raise ValidationError(f"未知的 definition section：{unknown[0]!r}")
    locked = _lock_version_for_write(version)
    if locked.status == RulesetVersion.Status.FROZEN:
        raise PermissionDenied("已冻结赛制版本不可编辑。")
    if base_content_hash is not None and locked.content_hash != base_content_hash:
        raise ValidationError("赛制已被其他编辑修改，请刷新后重试。")
    try:
        root = json.loads(locked.definition)
    except (TypeError, ValueError) as exc:
        raise ValidationError("赛制定义不是合法 JSON，无法按 section 保存。") from exc
    if not isinstance(root, dict):
        raise ValidationError("赛制定义的根必须是对象。")
    sections_to_apply = dict(sections)
    if allow_empty_checkpoints and sections_to_apply.get("checkpoints") == []:
        # An empty checkpoint list is not a valid general ruleset document.  The business
        # editor nevertheless needs a valid roster-only blank state, represented by an
        # omitted optional field.
        root.pop("checkpoints", None)
        sections_to_apply.pop("checkpoints")
    root.update(sections_to_apply)
    parse_definition(root)
    if "questionnaire" in root:
        # The questionnaire editor's save is a schema gate too, so a broken question is
        # refused where it was written rather than at freeze.
        parse_questionnaire(root["questionnaire"])
    locked.definition = json.dumps(root, ensure_ascii=False)
    locked.save(update_fields=["definition"])
    return locked


@transaction.atomic
def update_ruleset_definition_section(
    version: RulesetVersion,
    *,
    section: str,
    value,
    operator,
    base_content_hash: str | None = None,
) -> RulesetVersion:
    """Backward-compatible single-section wrapper around the atomic multi-section service."""
    return update_ruleset_definition_sections(
        version,
        sections={section: value},
        operator=operator,
        base_content_hash=base_content_hash,
    )


def validate_definition_completeness(definition) -> tuple[ReportIssue, ...]:
    """Return hard issues for a syntactically valid definition with no contest stage.

    ``ROSTER`` is an intentional blank starting point for the business editor, but it is
    not a freezeable contest. Keeping this check separate from graph compilation lets the
    editor explain the state without teaching the low-level schema parser UI concepts.
    """
    try:
        parsed = parse_definition(definition)
    except ValidationError:
        return ()
    stage_types = {
        "ASSESS",
        "AGGREGATE",
        "RANK",
        "SELECT",
        "MANUAL_SELECT",
        "PAIR",
        "DUEL",
        "FILL_TO_QUOTA",
    }
    if any(node.get("type") in stage_types for node in parsed.get("nodes", ())):
        return ()
    return (
        ReportIssue(
            code="RULESET_INCOMPLETE",
            severity=Severity.ERROR,
            path="nodes",
            message="赛制尚未设置比赛环节，至少需要一个评分、排名或晋级节点。",
        ),
    )


def _business_stage_round_requests(stages, normalized_stages: list[dict]) -> list[dict]:
    """Expand the stage payload into the round configuration requests it authorizes."""
    raw_by_key = {
        str(stage.get("key") or f"stage{index}"): stage
        for index, stage in enumerate(stages, start=1)
        if isinstance(stage, dict)
    }
    requests = []
    for index, stage in enumerate(normalized_stages, start=1):
        raw = raw_by_key.get(stage["key"], {})
        raw_sources = raw.get("judge_sources")
        raw_source_list = list(raw_sources) if isinstance(raw_sources, (list, tuple)) else []
        for source_index, source in enumerate(stage["judge_sources"]):
            raw_source = (
                raw_source_list[source_index]
                if source_index < len(raw_source_list)
                and isinstance(raw_source_list[source_index], dict)
                else {}
            )
            raw_round_id = raw_source.get("round_id", raw.get("round_id"))
            requests.append(
                {
                    "stage": stage,
                    "stage_index": index,
                    "source": source,
                    "round_id": raw_round_id,
                    "create_round": bool(
                        raw_source.get("create_round", raw.get("create_round", False))
                    ),
                    "scoring_mode": raw_source.get(
                        "scoring_mode", raw.get("scoring_mode", "average")
                    ),
                    "scoring_mode_conflict_ack": bool(
                        raw_source.get(
                            "scoring_mode_conflict_ack",
                            raw.get("scoring_mode_conflict_ack", False),
                        )
                    ),
                    "source_stage_key": source["source_stage_key"],
                }
            )
            for field in ("judge_count", "minimum_judge_count", "rubric_id"):
                if field in raw_source:
                    requests[-1][field] = raw_source[field]
    return requests


def _business_round_id(value, *, label: str) -> int | None:
    if value in (None, ""):
        return None
    try:
        result = int(value)
    except (TypeError, ValueError) as exc:
        raise ValidationError(f"轮次“{label}”的绑定 id 无效。") from exc
    if result <= 0:
        raise ValidationError(f"轮次“{label}”的绑定 id 无效。")
    return result


def _business_round_count(value, *, label: str) -> int | None:
    if value in (None, ""):
        return None
    try:
        result = int(value)
    except (TypeError, ValueError) as exc:
        raise ValidationError(f"轮次“{label}”的评委人数配置无效。") from exc
    if result <= 0:
        raise ValidationError(f"轮次“{label}”的评委人数配置必须是正整数。")
    return result


@transaction.atomic
def save_business_ruleset(
    version: RulesetVersion,
    *,
    stages,
    operator,
    base_content_hash: str | None = None,
    base_binding: str | None = None,
    base_round_configuration: str | None = None,
) -> RulesetVersion:
    """Atomically save the linear business editor and its activity-owned draft rounds."""
    require_current_staff(operator)
    from singer_contest.models import ContestRound, ScoringRubric

    if not isinstance(base_content_hash, str) or not base_content_hash:
        raise ValidationError("业务编辑保存必须提供 definition 版本校验值。")
    if not isinstance(base_binding, str) or not base_binding:
        raise ValidationError("业务编辑保存必须提供绑定版本校验值。")
    if not isinstance(base_round_configuration, str) or not base_round_configuration:
        raise ValidationError("业务编辑保存必须提供轮次配置版本校验值。")

    locked = _lock_version_for_write(version)
    if locked.status == RulesetVersion.Status.FROZEN:
        raise PermissionDenied("已冻结赛制版本不可编辑。")
    if locked.content_hash != base_content_hash:
        raise ValidationError("赛制已被其他编辑修改，请刷新后重试。")
    locked_ruleset = ContestRuleset.objects.select_for_update().get(pk=locked.ruleset_id)
    if _binding_signature(locked_ruleset) != base_binding:
        raise ValidationError("赛制绑定已被其他编辑修改，请刷新后重试。")
    old_definition = locked.definition
    old_binding = _snapshot_binding(locked_ruleset)
    old_round_configuration = _business_round_configuration_snapshot(
        ContestRound.objects.filter(activity_id=locked_ruleset.activity_id)
    )

    stage_list = list(stages or [])
    try:
        root = json.loads(locked.definition)
    except (TypeError, ValueError) as exc:
        raise ValidationError("赛制定义不是合法 JSON，无法保存业务规则。") from exc
    if not isinstance(root, dict):
        raise ValidationError("赛制定义的根必须是对象。")
    old_projection = infer_business_stages(locked.definition)
    if not old_projection.get("editable"):
        raise ValidationError(old_projection.get("reason") or "当前赛制不能由业务编辑器无损保存。")
    existing_context = root.get("context") or {}
    if not isinstance(existing_context, dict):
        raise ValidationError("赛制 context 必须是对象。")

    existing_business = existing_context.get("business") or {}
    if not isinstance(existing_business, dict):
        raise ValidationError("赛制 context.business 必须是对象。")
    # The graph projection is the execution authority.  ``context.business`` keeps
    # operator-facing labels, but may be stale after an advanced-editor change.
    old_business = old_projection.get("stages") or []
    old_keys = [item.get("key") for item in old_business if isinstance(item, dict)]
    new_keys = [str(item.get("key") or f"stage{index}") for index, item in enumerate(stage_list, 1)]
    shared_count = min(len(old_keys), len(new_keys))
    if new_keys[:shared_count] != old_keys[:shared_count]:
        for old_index, old_key in enumerate(old_keys):
            if old_key not in new_keys and any(
                key in new_keys for key in old_keys[old_index + 1 :]
            ):
                dependent = next(key for key in old_keys[old_index + 1 :] if key in new_keys)
                raise ValidationError(
                    f"阶段“{dependent}”依赖已删除的阶段“{old_key}”，不能删除中间阶段。"
                )
        raise ValidationError("业务编辑器只允许在末尾追加或删除比赛阶段，不能插入、重排或改名。")

    nodes, checkpoints, business_context = business_definition_from_stages(
        stage_list, existing_context=existing_context
    )
    normalized_stages = business_context["business"]["stages"]
    round_requests = _business_stage_round_requests(stage_list, normalized_stages)
    existing_round_keys = dict(locked_ruleset.round_keys or {})
    old_business_round_keys = {
        str(item.get("round_key"))
        for item in old_business
        if isinstance(item, dict) and item.get("round_key")
    }
    for item in old_business:
        if not isinstance(item, dict):
            continue
        old_business_round_keys.update(
            str(source.get("round_key"))
            for source in item.get("judge_sources") or ()
            if isinstance(source, dict) and source.get("round_key")
        )

    round_ids_by_key: dict[str, int] = {}
    requested_ids = {
        parsed
        for request in round_requests
        if (parsed := _business_round_id(request["round_id"], label=request["source"]["round_key"]))
    }
    referenced_round_keys = {request["source"]["round_key"] for request in round_requests}
    referenced_existing_ids = {
        int(existing_round_keys[key])
        for key in referenced_round_keys
        if str(existing_round_keys.get(key, "")).isdigit() and int(existing_round_keys[key]) > 0
    }
    old_business_existing_ids = {
        int(existing_round_keys[key])
        for key in old_business_round_keys
        if str(existing_round_keys.get(key, "")).isdigit() and int(existing_round_keys[key]) > 0
    }
    relevant_ids = referenced_existing_ids | requested_ids | old_business_existing_ids
    try:
        base_round_snapshot = json.loads(base_round_configuration)
    except (TypeError, ValueError) as exc:
        raise ValidationError("轮次配置版本校验值无效。") from exc
    if not isinstance(base_round_snapshot, dict):
        raise ValidationError("轮次配置版本校验值无效。")
    locked_round_configuration = list(
        ContestRound.objects.select_for_update().filter(
            activity_id=locked_ruleset.activity_id,
            pk__in=relevant_ids,
        )
    )
    current_round_snapshot = _business_round_configuration_snapshot(locked_round_configuration)
    if any(
        base_round_snapshot.get(str(round_id)) != current_round_snapshot.get(str(round_id))
        for round_id in relevant_ids
    ):
        raise ValidationError("比赛轮次配置已被其他编辑修改，请刷新后重试。")
    current_frozen = (
        RulesetVersion._base_manager.filter(
            ruleset_id=locked.ruleset_id,
            status=RulesetVersion.Status.FROZEN,
            is_current=True,
        )
        .exclude(pk=locked.pk)
        .values_list("binding", flat=True)
        .first()
    )
    frozen_round_keys = (
        current_frozen.get("round_keys", {}) if isinstance(current_frozen, dict) else {}
    )
    protected_round_ids = {
        int(round_id)
        for round_id in frozen_round_keys.values()
        if str(round_id).isdigit() and int(round_id) > 0
    }
    locked_rounds = {round_.pk: round_ for round_ in locked_round_configuration}
    if requested_ids - set(locked_rounds):
        raise ValidationError("业务编辑器只能绑定属于当前活动的轮次。")

    for request in round_requests:
        round_key = request["source"]["round_key"]
        if request["create_round"] and existing_round_keys.get(round_key) not in (None, ""):
            raise ValidationError(f"轮次键“{round_key}”已经绑定已有轮次，不能按创建新轮次处理。")

    key_to_id: dict[str, int] = {}
    for request in round_requests:
        round_key = request["source"]["round_key"]
        explicit_id = _business_round_id(request["round_id"], label=round_key)
        mapped_id = explicit_id or _business_round_id(
            existing_round_keys.get(round_key), label=round_key
        )
        if mapped_id is not None:
            prior_id = key_to_id.get(round_key)
            if prior_id is not None and prior_id != mapped_id:
                raise ValidationError(f"轮次“{round_key}”在同一保存中绑定了多个轮次。")
            key_to_id[round_key] = mapped_id
    owner_by_id: dict[int, str] = {}
    for round_key, mapped_id in key_to_id.items():
        prior_key = owner_by_id.get(mapped_id)
        if prior_key is not None and prior_key != round_key:
            raise ValidationError(
                f"轮次 id {mapped_id} 不能同时作为“{prior_key}”和“{round_key}”的配置所有者。"
            )
        owner_by_id[mapped_id] = round_key

    configured_ids: set[int] = set()
    scoring_modes_by_id: dict[int, str] = {}
    roster_scopes_by_id: dict[int, tuple[str, str]] = {}
    for request in round_requests:
        stage = request["stage"]
        source = request["source"]
        round_key = source["round_key"]
        explicit_id = _business_round_id(request["round_id"], label=round_key)
        mapped_id = (
            explicit_id
            or _business_round_id(existing_round_keys.get(round_key), label=round_key)
            or round_ids_by_key.get(round_key)
        )
        created_round = False
        source_stage_key = request["source_stage_key"]
        roster_source = (
            ContestRound.RosterSource.APPROVED
            if source_stage_key == ENTRY_KEY
            else ContestRound.RosterSource.STAGE
        )
        roster_source_stage = "" if source_stage_key == ENTRY_KEY else source_stage_key
        if mapped_id is None:
            if not request["create_round"]:
                raise ValidationError(f"轮次“{round_key}”尚未绑定，请明确选择创建草稿轮次。")
            round_type = (
                ContestRound.RoundType.PRELIMINARY
                if request["stage_index"] == 1
                else ContestRound.RoundType.SEMI_FINAL
            )
            with authority_write(CONTEST_ROUND_STATE):
                created = ContestRound.objects.create(
                    activity_id=locked_ruleset.activity_id,
                    round_type=round_type,
                    scoring_mode=request["scoring_mode"],
                    name=source["round_name"] or stage["name"],
                    advance_count=stage["advance_count"],
                    roster_source=roster_source,
                    roster_source_stage=roster_source_stage,
                )
            mapped_id = created.pk
            created_round = True
            locked_rounds[mapped_id] = created
            owner_by_id[mapped_id] = round_key
        round_ = locked_rounds[mapped_id]
        round_ids_by_key[round_key] = mapped_id
        if (
            not created_round
            and round_.scoring_mode != request["scoring_mode"]
            and not request["scoring_mode_conflict_ack"]
        ):
            raise ValidationError(
                f"轮次“{round_.name or round_.pk}”当前评分方式与规则定义不一致，"
                "请明确确认后再同步。"
            )
        desired = {
            "name": source["round_name"] or round_.name or stage["name"],
            "scoring_mode": request["scoring_mode"],
            "advance_count": stage["advance_count"],
            "roster_source": roster_source,
            "roster_source_stage": roster_source_stage,
        }
        if "judge_count" in request:
            desired["judge_count"] = _business_round_count(request["judge_count"], label=round_key)
        if "minimum_judge_count" in request:
            desired["minimum_judge_count"] = _business_round_count(
                request["minimum_judge_count"], label=round_key
            )
        if "rubric_id" in request:
            rubric_id = _business_round_id(request["rubric_id"], label=round_key)
            if (
                rubric_id is not None
                and not ScoringRubric.objects.filter(
                    pk=rubric_id, activity_id=locked_ruleset.activity_id
                ).exists()
            ):
                raise ValidationError(f"轮次“{round_key}”的评分标准不属于当前活动。")
            desired["rubric_id"] = rubric_id
        next_judge_count = desired.get("judge_count", round_.judge_count)
        next_minimum_judge_count = desired.get("minimum_judge_count", round_.minimum_judge_count)
        if (
            next_judge_count is not None
            and next_minimum_judge_count is not None
            and int(next_minimum_judge_count) > int(next_judge_count)
        ):
            raise ValidationError(f"轮次“{round_key}”的最低有效评委数不能超过评委数量。")
        prior_mode = scoring_modes_by_id.get(mapped_id)
        if prior_mode is not None and prior_mode != request["scoring_mode"]:
            raise ValidationError(
                f"轮次“{round_.name or mapped_id}”不能在不同阶段使用不同评分方式。"
            )
        scoring_modes_by_id[mapped_id] = request["scoring_mode"]
        prior_roster_scope = roster_scopes_by_id.get(mapped_id)
        if prior_roster_scope is not None and prior_roster_scope != (
            desired["roster_source"],
            desired["roster_source_stage"],
        ):
            prior_source, prior_stage = prior_roster_scope
            requested_source, requested_stage = (
                desired["roster_source"],
                desired["roster_source_stage"],
            )
            # An approved roster is a superset of any stage roster, so a later
            # subset reference is safe while the reverse direction is not.
            compatible_subset = (
                prior_source == ContestRound.RosterSource.APPROVED
                and requested_source == ContestRound.RosterSource.STAGE
            )
            if not compatible_subset:
                raise ValidationError(
                    f"轮次“{round_.name or round_.pk}”被不同阶段引用了不兼容的参赛名单范围 "
                    f"（{prior_source}/{prior_stage} 与 {requested_source}/{requested_stage}）。"
                )
        roster_scopes_by_id.setdefault(
            mapped_id,
            (desired["roster_source"], desired["roster_source_stage"]),
        )
        # A round referenced by multiple stages has one configuration owner: the first
        # occurrence.  Later references keep the original roster/advance configuration.
        if owner_by_id.get(mapped_id) == round_key and mapped_id not in configured_ids:
            changed = any(getattr(round_, field) != value for field, value in desired.items())
            if mapped_id in protected_round_ids and changed:
                raise PermissionDenied(
                    f"当前冻结赛制仍使用轮次“{round_.name or mapped_id}”，不能修改其执行配置。"
                )
            if (round_.status != ContestRound.Status.DRAFT or round_.is_locked) and changed:
                raise PermissionDenied(
                    f"轮次“{round_.name or round_.pk}”已准备，不能由业务编辑器修改。"
                )
            if changed:
                for field, value in desired.items():
                    setattr(round_, field, value)
                with authority_write(CONTEST_ROUND_STATE):
                    round_.save(update_fields=list(desired))
            configured_ids.add(mapped_id)

    binding = _snapshot_binding(locked_ruleset)
    binding["round_keys"] = {
        key: value
        for key, value in existing_round_keys.items()
        if key not in old_business_round_keys or key in round_ids_by_key
    }
    binding["round_keys"].update(round_ids_by_key)
    for stage in normalized_stages:
        if Decimal(stage["audience_weight"]) and stage["vote_source"] not in (
            locked_ruleset.vote_keys or {}
        ):
            raise ValidationError(f"投票来源“{stage['vote_source']}”尚未绑定到当前活动。")
    update_ruleset_binding(
        locked_ruleset,
        binding=binding,
        operator=operator,
        base_binding=base_binding,
    )
    locked_ruleset.refresh_from_db()
    new_binding = _snapshot_binding(locked_ruleset)
    saved = update_ruleset_definition_sections(
        locked,
        sections={"nodes": nodes, "checkpoints": checkpoints, "context": business_context},
        operator=operator,
        base_content_hash=base_content_hash,
        allow_empty_checkpoints=True,
    )
    new_round_configuration = _business_round_configuration_snapshot(
        ContestRound.objects.filter(activity_id=locked_ruleset.activity_id)
    )
    AuditLog.objects.create(
        operator=operator,
        action_type=AuditLog.ActionType.OTHER,
        target=f"RulesetVersion:{saved.pk}",
        old_value=json.dumps(
            {
                "definition": old_definition,
                "binding": old_binding,
                "round_configuration": old_round_configuration,
            },
            ensure_ascii=False,
        ),
        new_value=json.dumps(
            {
                "definition": saved.definition,
                "binding": new_binding,
                "round_configuration": new_round_configuration,
            },
            ensure_ascii=False,
        ),
    )
    return saved


@transaction.atomic
def update_ruleset_binding(
    ruleset: ContestRuleset, *, binding: dict, operator, base_binding: str | None = None
) -> ContestRuleset:
    """Persist a ContestRuleset binding edit under the Activity-first lock.

    Re-reads the ruleset after locking, validates/normalizes the binding, and rejects a
    save whose editor started from a stale binding surface (``base_binding`` signature).
    Does not touch the version: the snapshot runs at freeze time.
    """
    require_current_staff(operator)
    lock_activity_for_action(ruleset.activity)
    locked = ContestRuleset.objects.select_for_update().get(pk=ruleset.pk)
    if base_binding is not None and _binding_signature(locked) != base_binding:
        raise ValidationError("赛制绑定已被其他编辑修改，请刷新后重试。")
    normalized = validate_binding(locked, binding)
    locked.stage_key = normalized["stage_key"]
    locked.round_keys = normalized["round_keys"]
    locked.vote_keys = normalized["vote_keys"]
    locked.vote_scoring_rule_keys = normalized["vote_scoring_rule_keys"]
    locked.group_keys = normalized["group_keys"]
    locked.group_stage_keys = normalized["group_stage_keys"]
    locked.audience_keys = normalized["audience_keys"]
    locked.live_challenge = normalized.get("live_challenge") or {}
    locked.announcement_blocks = normalized["announcement_blocks"]
    locked.announcement_blocks_by_checkpoint = normalized["announcement_blocks_by_checkpoint"]
    locked.save(
        update_fields=[
            "stage_key",
            "round_keys",
            "vote_keys",
            "vote_scoring_rule_keys",
            "group_keys",
            "group_stage_keys",
            "audience_keys",
            "live_challenge",
            "announcement_blocks",
            "announcement_blocks_by_checkpoint",
            "updated_at",
        ]
    )
    return locked


# Phases in which the approved-singer roster is settled. Before these the roster genuinely
# does not exist yet, so every fact derived from it is UNKNOWN rather than zero — which is
# what lets a ruleset be confirmed before registration opens (see
# :func:`validate_ruleset_runtime_readiness`).
ROSTER_FINAL_PHASES = frozenset(
    {
        Activity.Phase.TESTING,  # a rehearsal runs on an already-materialised roster
        Activity.Phase.REHEARSAL,
        Activity.Phase.LIVE,
        Activity.Phase.RESULTS_PENDING,
        Activity.Phase.RESULTS_PUBLISHED,
        Activity.Phase.ARCHIVED,
    }
)


def entry_roster_is_final(activity) -> bool:
    """Whether the approved-singer roster is settled enough to prove roster facts."""
    return activity.phase in ROSTER_FINAL_PHASES


def current_frozen_version(activity) -> RulesetVersion | None:
    """The activity's current official FROZEN ruleset authority, if it has one."""
    return (
        RulesetVersion._base_manager.filter(
            ruleset__activity=activity,
            is_current=True,
            status=RulesetVersion.Status.FROZEN,
        )
        .order_by("-pk")
        .first()
    )


def require_runtime_readiness(activity) -> ValidationReport | None:
    """The unified runtime boundary for every "start running the contest" entry point.

    A ruleset is confirmed before registration opens, so the facts that depend on the
    final roster are DEFERRED at Freeze and proven here — the last moment before they
    become load-bearing. Returns ``None`` when the activity has no current FROZEN
    authority (those call sites already refuse to run without one); raises otherwise.

    Attached at :func:`singer_contest.services.prepare_round` (start scoring a round) and
    :func:`voting.services.open_vote_session` (start collecting ballots) — the two points
    that actually begin execution. It is deliberately *not* attached to
    ``maybe_resolve_checkpoints``: that is a result-publishing step downstream of both,
    it runs after every onsite input batch, and a full bound compile per batch is a heavy
    price on the hottest path. The rounds whose results it publishes were already gated
    when they were prepared.
    """
    version = current_frozen_version(activity)
    if version is None:
        return None
    return validate_ruleset_runtime_readiness(version)


def build_bound_context(version: RulesetVersion, binding: dict) -> dict:
    """Construct the §39 bound freeze context from the DB for a ContestRuleset.

    Unlike a template (which legitimately has no real entities and may WARN), a bound
    activity freeze must prove every verifiable fact or fail. ``entry_size`` is the
    scoped approved-singer count; each bound round contributes its real ``judge_count``,
    a ``scope`` ("full" when the round's RoundEntries cover the entry roster, else
    "subset"), and a ``scale`` derived from its rubric's aggregate criterion maximum;
    each vote source contributes its CONFIG ``scale``/``normalization`` (never a runtime
    ``result_ready`` — 0 ballots is a freeze-legal pre-contest state); each group
    partition contributes per-group ``capacity``. Facts the DB cannot supply are left
    unset so the bound compiler escalates the corresponding "unverifiable" WARN to a
    hard ERROR and refuses the freeze instead of inventing a value.
    """
    from singer_contest.models import ContestRound

    activity = version.ruleset.activity
    round_keys = binding.get("round_keys") or {}
    roster_final = entry_roster_is_final(activity)
    entry_size = _scoped_entry_count(activity) if roster_final else None

    round_ctx: dict[str, dict] = {}
    for rkey, rpk in round_keys.items():
        contest_round = ContestRound.objects.filter(pk=rpk, activity=activity).first()
        if contest_round is None:
            continue
        judge_count = (
            contest_round.judge_count
            if contest_round.judge_count is not None
            else contest_round.round_judges.count()
        )
        item: dict = {"judge_count": judge_count}
        if roster_final:
            entry_count = contest_round.entries.count()
            item["scope"] = (
                "full" if entry_count and entry_size and entry_count >= entry_size else "subset"
            )
        scale = _round_scale(contest_round)
        if scale:
            item["scale"] = scale
        round_ctx[rkey] = item

    # §6.2: a bound session only reports a hundred-mark score when the binding names the
    # VoteScoringRule that converts it; a purpose alone never implies a conversion.
    scoring_rules = binding.get("vote_scoring_rule_keys") or {}
    votes = {}
    for source, vs_pk in (binding.get("vote_keys") or {}).items():
        vote = _vote_binding(vs_pk, scoring_rules.get(source), roster_final=roster_final)
        if vote:
            votes[source] = vote
    for source, _set_name in (binding.get("audience_keys") or {}).items():
        # Audience scores are staff-entered 0-100 values (not raw vote counts), so they
        # bind at a hundred scale for the compiler's scale-truth check.
        votes[source] = {"scale": "hundred"}

    groups = {}
    for by, rpk in (binding.get("group_keys") or {}).items():
        caps = list(_annotated_capacity(rpk, activity))
        if caps:
            groups[by] = {"capacity": caps}
    from singer_contest.models import GroupStage

    for by, stage_pk in (binding.get("group_stage_keys") or {}).items():
        stage = (
            GroupStage.objects.filter(
                pk=stage_pk,
                activity=activity,
                status=GroupStage.Status.FROZEN,
            )
            .prefetch_related("groups__memberships")
            .first()
        )
        if stage is not None:
            capacities = [
                group.memberships.filter(is_current=True).count()
                for group in stage.groups.filter(is_active=True).order_by("group_order", "pk")
            ]
            if capacities:
                groups[by] = {"capacity": capacities}

    return {
        "entry_roster_final": roster_final,
        "entry_size": entry_size,
        "entry_candidates": _entry_candidates(version, activity) if roster_final else None,
        "rounds": round_ctx,
        "votes": votes,
        "groups": groups,
    }


def _entry_candidates(version, activity) -> list[str]:
    """The entry roster's candidate ids, exactly as the runtime resolver loads them.

    §7.3 needs the real pool identity (not just its size) to refuse a score-component vote
    whose roster drifted from the roster the stage actually scores. Read through the same
    helper the resolver uses so a freeze-time comparison cannot disagree with runtime.
    """
    from singer_contest.services import _stage_entry_roster

    return [str(pk) for pk in _stage_entry_roster(version, activity, {})]


def _scoped_entry_count(activity) -> int:
    from singer_contest.models import SingerRegistration

    return SingerRegistration.objects.filter(
        activity=activity, pre_status=SingerRegistration.PreStatus.APPROVED
    ).count()


def _round_scale(contest_round) -> str | None:
    rubric_id = getattr(contest_round, "rubric_id", None)
    if rubric_id is None:
        return None
    from decimal import Decimal

    from django.db.models import Sum
    from singer_contest.models import ScoringRubric

    total = ScoringRubric.objects.filter(pk=rubric_id).aggregate(s=Sum("criteria__max_score"))["s"]
    if total is None:
        return None
    # M1-R9 (§25 "不要继续用 ten/hundred"): a rubric declares a numeric score_max, not a
    # coarse "hundred"/"ten" bucket. Summing the criteria gives the true sheet maximum, so
    # a 50-mark sheet is "50", a 10-mark sheet is "10", and a 100-mark sheet is "100".
    # The old "non-100 is ten" collapsed 50/30/20/10 into one bucket and let a 50-mark
    # sheet be direct-summed with a 10-mark sheet as if the units matched.
    return str(int(Decimal(total)))


def _vote_binding(vs_pk, rule_snapshot: dict | None = None, *, roster_final: bool = True) -> dict:
    """The bound vote facts a freeze compiles against.

    Without an explicitly bound conversion rule a session yields RAW vote counts (unit
    ``votes``), never a pre-normalized hundred-mark score: the compiler rejects a
    SCORE_COMPONENT source in that state (``VOTE_SCORE_COMPONENT_RAW``). With a bound rule
    the conversion's *meaning* comes from the frozen snapshot (mode + output scale), so the
    rule's current row is never consulted at replay. Candidate ids ride along for the
    §7.3 roster-equality gate.

    Runtime vote readiness (ballots cast / locked / result ready) remains a resolver HOLD
    condition, never a Freeze gate — so no ``result_ready`` fact is produced here.
    """
    from voting.models import VoteOption, VoteSession

    vs = VoteSession.objects.filter(pk=vs_pk).first()
    if vs is None:
        return {}
    binding = {
        "purpose": vs.purpose,
        "requires_ticket": vs.requires_ticket,
    }
    if roster_final:
        binding["candidates"] = [
            str(singer_id)
            for singer_id in VoteOption.objects.filter(vote_session_id=vs_pk)
            .order_by("pk")
            .values_list("singer_id", flat=True)
        ]
    if rule_snapshot:
        binding["scale"] = rule_snapshot.get("scale") or "hundred"
        binding["conversion"] = rule_snapshot.get("mode")
        binding["scoring_rule"] = rule_snapshot.get("rule")
    else:
        binding["scale"] = "votes"
    return binding


def _annotated_capacity(rpk, activity):
    from django.db.models import Count
    from singer_contest.models import PerformanceGroup

    return (
        PerformanceGroup.objects.filter(round_id=rpk, activity=activity)
        .annotate(n=Count("performances"))
        .values_list("n", flat=True)
    )


def _questionnaire_plan_of(version: RulesetVersion) -> QuestionnairePlan | None:
    """The compiled questionnaire of a version, or ``None`` when it carries none."""
    try:
        root = json.loads(version.definition)
    except (TypeError, ValueError):
        return None
    if not isinstance(root, dict):
        return None
    raw = root.get("questionnaire")
    return compile_questionnaire(raw) if raw is not None else None


def _validate_successor_questionnaire(
    previous: RulesetVersion | None, version: RulesetVersion
) -> None:
    """A successor may add or drop questions, but may not silently redefine one.

    Reusing ``r2.accompaniment`` for a background video would keep every participant's
    stored answer in a slot whose meaning changed under it. Adding a new key is the edit
    that says what the operator means.
    """
    if previous is None:
        return
    from questionnaire.successor import validate_successor

    before = _questionnaire_plan_of(previous)
    after = _questionnaire_plan_of(version)
    if before is None or after is None:
        return
    validate_successor(before, after)


def _carry_questionnaire_answers(
    previous: RulesetVersion | None, version: RulesetVersion, plan: QuestionnairePlan | None
) -> int:
    """Open a response on the new version for everyone who answered the old one.

    Only free-text answers move: bound answers already live on the registration, and file
    answers are read by ``question_key`` through ``is_current``, so both carry themselves.
    A participant who never filled anything in gets no row — a response means someone
    answered something, and blank rows would be noise rather than migration.
    """
    if previous is None or plan is None:
        return 0
    from questionnaire.models import QuestionnaireResponse
    from questionnaire.successor import carry_answers

    before = _questionnaire_plan_of(previous)
    if before is None:
        return 0
    carried = 0
    rows = QuestionnaireResponse.objects.filter(ruleset_version=previous).select_related(
        "group", "singer_registration"
    )
    for old in rows:
        answers = carry_answers(before, plan, old.answers)
        identity = (
            {"group_id": old.group_id, "subject": QuestionnaireResponse.Subject.GROUP}
            if old.group_id
            else {
                "singer_registration_id": old.singer_registration_id,
                "subject": QuestionnaireResponse.Subject.PARTICIPANT,
            }
        )
        QuestionnaireResponse.objects.update_or_create(
            **identity,
            ruleset_version=version,
            questionnaire_key=plan.key,
            defaults={
                "schema_hash": plan.schema_hash,
                "answers": answers,
                "is_test_data": old.is_test_data,
            },
        )
        # A successor can add a question to a response that already existed, and the
        # per-question material checks are otherwise created on the form's *first open* —
        # which for this participant has already happened. Without this the new question has
        # no check at all, `writable_question_keys` therefore offers nothing, and staff have
        # no way to grant a supplement for it either: once registration is closed that
        # participant can never answer a question they were never asked to answer.
        owner = old.group if old.group_id else old.singer_registration
        if owner is not None:
            from files.services import reconcile_questionnaire_material_checks

            reconcile_questionnaire_material_checks(registration=owner, version=version, plan=plan)
        carried += 1
    return carried


def _has_live_audience_dependency(value) -> bool:
    """Return whether a ruleset definition declares any audience-score input."""
    if isinstance(value, dict):
        if str(value.get("vote_source") or "").strip():
            return True
        if str(value.get("audience_source") or "").strip():
            return True
        if "audience_weight" in value:
            try:
                if Decimal(str(value.get("audience_weight") or "0")) != 0:
                    return True
            except (InvalidOperation, TypeError, ValueError):
                return True
        return any(_has_live_audience_dependency(child) for child in value.values())
    if isinstance(value, list):
        return any(_has_live_audience_dependency(child) for child in value)
    return False


def _live_first_round_select_count(root: dict, first_round_key: str) -> int | None:
    """The qualifier SELECT's count for the first round, or ``None`` when the graph differs.

    Walks the shape the built-in ships (ASSESS(round=r1) → RANK → SELECT) rather than guessing,
    so a hand-edited graph is simply not checked here instead of being misread.
    """

    nodes = [node for node in (root.get("nodes") or []) if isinstance(node, dict)]
    by_source: dict[object, list[dict]] = {}
    for node in nodes:
        by_source.setdefault(node.get("source"), []).append(node)
    assess = next(
        (
            node
            for node in nodes
            if node.get("type") == "ASSESS" and str(node.get("round") or "") == first_round_key
        ),
        None,
    )
    if assess is None:
        return None
    for rank in by_source.get(assess.get("key"), []):
        if rank.get("type") != "RANK":
            continue
        for select in by_source.get(rank.get("key"), []):
            if select.get("type") == "SELECT" and isinstance(select.get("count"), int):
                return select["count"]
    return None


def _validate_2026_live_contract(root: dict, binding: dict) -> None:
    """Validate the cross-domain invariants unique to the 2026 live format."""
    live_config = binding.get("live_challenge") or {}
    if (
        not isinstance(live_config, dict)
        or live_config.get("format_key") != LIVE_CHALLENGE_FORMAT_KEY
    ):
        return

    if (
        binding.get("vote_keys")
        or binding.get("vote_scoring_rule_keys")
        or binding.get("audience_keys")
    ):
        raise ValidationError("2026 现场赛制不得依赖观众投票或人工观众分。")
    if _has_live_audience_dependency(root):
        raise ValidationError("2026 现场赛制不得声明观众成绩来源。")

    from singer_contest.models import ContestRound

    round_keys = binding.get("round_keys") or {}
    first_round_key = str(live_config.get("podium_first_round_key") or "r1").strip()
    first_round_id = round_keys.get(first_round_key)
    if first_round_id in (None, ""):
        raise ValidationError("2026 现场赛制必须绑定第一轮物理评分轮。")
    first_round = (
        ContestRound.objects.filter(pk=first_round_id).prefetch_related("rubric__criteria").first()
    )
    if first_round is None:
        raise ValidationError("2026 现场赛制绑定的第一轮物理评分轮不存在。")
    # The counts are present whenever a ruleset actually freezes: ``validate_binding`` runs
    # first and refuses to normalize a live block without them. A binding that never declared
    # them is not the parameterized shape, so the counts-derived relations are skipped rather
    # than compared against a zero that means "absent".
    seat_count = int(live_config.get("seat_count") or 0)
    if seat_count and first_round.advance_count != seat_count:
        raise ValidationError(f"2026 现场赛制第一轮晋级人数必须等于初始席位数（{seat_count}）。")
    # The definition's qualifier SELECT is a second copy of the seat count. It can only be
    # *checked*, never derived: rewriting the definition at freeze would move content_hash and
    # so the identity every audited StageResult is keyed under.
    definition_count = _live_first_round_select_count(root, first_round_key)
    if seat_count and definition_count is not None and definition_count != seat_count:
        raise ValidationError(
            f"2026 现场赛制第一轮的晋级名额（{definition_count}）"
            f"与初始席位数（{seat_count}）不一致。"
        )
    if first_round.score_completion_mode != ContestRound.CompletionMode.MINIMUM_VALID:
        raise ValidationError("2026 现场赛制第一轮必须使用最低有效评委数评分完成模式。")
    if first_round.judge_count is None or first_round.judge_count < 1:
        raise ValidationError("2026 现场赛制第一轮必须配置正整数评委人数。")
    minimum_judge_count = first_round.minimum_judge_count
    if (
        minimum_judge_count is None
        or minimum_judge_count < 1
        or minimum_judge_count > first_round.judge_count
    ):
        raise ValidationError(
            "2026 现场赛制第一轮最低有效评委数必须在 1 至评委人数之间，不能超过评委人数。"
        )
    standard = scoring_standard_snapshot(first_round)
    if standard["scoring_mode"] != ContestRound.ScoringMode.AVERAGE:
        raise ValidationError("2026 现场赛制必须使用所有有效评委分的算术平均。")
    rubric = standard.get("rubric")
    if not isinstance(rubric, dict) or not rubric.get("criteria"):
        raise ValidationError("2026 现场赛制第一轮必须配置统一评分标准。")
    group_stage_keys = binding.get("group_stage_keys") or {}
    group_stage_id = group_stage_keys.get(first_round_key)
    if group_stage_id in (None, "") and len(group_stage_keys) == 1:
        # A single GroupStage binding may use the business ``by`` key (for example
        # ``chorus``) instead of the physical round key.  It is still unambiguous.
        group_stage_id = next(iter(group_stage_keys.values()))
    if "questionnaire" in root and group_stage_id in (None, ""):
        raise ValidationError("2026 现场赛制必须绑定第一轮冻结的分组合唱分组。")
    if group_stage_id not in (None, ""):
        from common.lifecycle import runtime_approved_singers
        from singer_contest.group_chorus import (
            validate_live_first_round_group_stage,
            validate_live_first_round_performance_groups,
        )
        from singer_contest.models import GroupStage

        if first_round.effective_roster_source() != ContestRound.RosterSource.APPROVED:
            raise ValidationError("2026 现场赛制第一轮必须使用全部审核通过的选手名单。")
        group_stage = (
            GroupStage.objects.filter(
                pk=group_stage_id,
                activity_id=first_round.activity_id,
                status=GroupStage.Status.FROZEN,
            )
            .prefetch_related("groups__memberships")
            .first()
        )
        if group_stage is None:
            raise ValidationError("2026 第一轮绑定的分组合唱分组不存在、未冻结或不属于当前活动。")
        group_snapshot = validate_live_first_round_group_stage(
            group_stage,
            runtime_approved_singers(first_round.activity).values_list("pk", flat=True),
            group_count=int(live_config.get("group_count") or LIVE_2026_GROUP_COUNT),
            group_size=int(live_config.get("group_size") or LIVE_2026_GROUP_SIZE),
        )
        validate_live_first_round_performance_groups(
            first_round,
            group_snapshot,
            require_groups=False,
        )
    # r2/r3 are questionnaire material namespaces. Their physical scoring rounds are
    # created by the challenge service only after the relevant roster exists.
    live_config["scoring_standard"] = standard


def _validate_frozen_questionnaire(definition, binding: dict) -> None:
    """The questionnaire freezes with the ruleset, so it must clear its own gate here.

    It lives inside ``definition``, so ``content_hash`` already canonicalises it — which is
    why editing one question moves the authority hash a StageResult is audited under, with
    no separate questionnaire authority to keep in sync. What freeze adds is the one fact
    neither compiler can see alone: every round a question binds must be a round this
    ruleset binds to a ContestRound of the activity.
    """
    try:
        root = json.loads(definition)
    except (TypeError, ValueError) as exc:
        raise ValidationError("赛制定义不是合法 JSON。") from exc
    if not isinstance(root, dict):
        raise ValidationError("赛制定义的根必须是对象。")
    raw = root.get("questionnaire")
    live_config = binding.get("live_challenge") or {}
    is_live_2026 = (
        isinstance(live_config, dict) and live_config.get("format_key") == LIVE_CHALLENGE_FORMAT_KEY
    )
    if raw is None:
        if is_live_2026:
            raise ValidationError("2026 赛制必须使用选手问卷收集第二、第三轮个人材料。")
        return
    plan = compile_questionnaire(raw)
    bound_round_keys = binding.get("round_keys") or {}
    logical_material_rounds = {"r2", "r3"} if is_live_2026 else set()
    validate_questionnaire_rounds(
        plan, bound_round_keys, logical_round_keys=logical_material_rounds
    )
    validate_questionnaire_context_keys(plan, bound_round_keys)
    if is_live_2026:
        from singer_contest.materials import validate_live_material_plan

        validate_live_material_plan(plan)
        _validate_2026_live_contract(root, binding)


def validate_ruleset_runtime_readiness(version: RulesetVersion) -> ValidationReport:
    """Re-run a frozen ruleset's deferred roster checks against the settled roster.

    A ruleset may be frozen before registration opens: its *definition* is provable then,
    its *roster* is not. Every check that had to wait is recorded as a DEFERRED issue at
    Freeze time and re-run here, where the roster is finally the authority. This is the
    last gate before the competition runs, so it fails closed in both directions — a roster
    that still does not exist is refused outright rather than read as an empty pass, and a
    roster that cannot support the frozen plan raises :class:`RulesetInvalidError`.
    """
    if version.status != RulesetVersion.Status.FROZEN:
        raise ValidationError("只有已冻结赛制可以核定运行时名单。")
    activity = version.ruleset.activity
    if not entry_roster_is_final(activity):
        raise ValidationError("报名名单尚未确定，无法核定运行时名单。")
    context = build_bound_context(version, version.binding or {})
    report, plan = compile_definition(version.definition, context=context, bound=True)
    if not report.passes():
        raise RulesetInvalidError(report, plan)
    return report


@transaction.atomic
def freeze_ruleset_version(
    version: RulesetVersion,
    operator,
    *,
    binding: dict | None = None,
) -> RulesetVersion:
    """Freeze a DRAFT ContestRuleset version, always at the *bound* activity level.

    ``binding`` (optional) supplies the editable input surface; when omitted it is
    snapshotted verbatim from the ruleset. Unlike a template freeze (bound=False), a
    ContestRuleset freeze builds the real context from the DB via :func:`build_bound_context`
    and compiles with ``bound=True``, so any fact the compiler could only WARN about as
    "unverifiable until bound" becomes an ERROR and aborts the freeze. Raises
    :class:`PermissionDenied` if the operator is not an effective admin or the activity is
    locked; :class:`ValidationError` if the version is already frozen or the binding is
    invalid; :class:`RulesetInvalidError` if compilation reports any ERROR.
    """
    locked = _lock_version_for_write(version)
    current_operator = require_current_admin(operator)
    if locked.status == RulesetVersion.Status.FROZEN:
        raise ValidationError("该赛制版本已冻结。")

    # M1-R9 (§五): a normal successor Freeze demotes the running FROZEN authority. That is
    # only legal while no result grounded in it is CONFIRMED — finality means a confirmed
    # handcard must stay attributable to the authority it was frozen under. If the current
    # version already has a CONFIRMED StageResult, reject the re-freeze (the operator must
    # first unlock the result via :func:`unlock_stage_result` to release finality).
    from singer_contest.models import StageResult

    prior = (
        RulesetVersion._base_manager.filter(ruleset_id=locked.ruleset_id)
        .exclude(pk=locked.pk)
        .filter(is_current=True, status=RulesetVersion.Status.FROZEN)
        .first()
    )
    if (
        prior is not None
        and prior.stage_results.filter(status=StageResult.Status.CONFIRMED).exists()
    ):
        raise ValidationError("当前冻结赛制已核定赛段结果，不可生成后继赛制版本。")

    freeze_binding = _snapshot_binding(locked.ruleset) if binding is None else binding
    normalized_binding = validate_binding(
        locked.ruleset,
        freeze_binding,
        require_live_challenge_complete=True,
    )
    # §6.1: freeze the conversion authority itself (rule id + mode + output scale). The
    # editable surface only names the rule; the snapshot records what it meant, so a replay
    # reads the frozen identity instead of asking the DB which rule the session "has now".
    normalized_binding["vote_scoring_rule_keys"] = vote_scoring_binding_snapshot(
        normalized_binding.get("vote_scoring_rule_keys")
    )
    bound_context = build_bound_context(locked, normalized_binding)
    report, plan = compile_definition(locked.definition, context=bound_context, bound=True)
    completeness_issues = validate_definition_completeness(locked.definition)
    if completeness_issues:
        report = ValidationReport(report.issues + completeness_issues)
    if not report.passes():
        raise RulesetInvalidError(report, plan)
    assert plan is not None
    _validate_frozen_questionnaire(locked.definition, normalized_binding)
    _validate_successor_questionnaire(prior, locked)

    old_status = "draft"
    with authority_write(RULESET_FREEZE):
        _demote_prior_current(locked)
    locked.status = RulesetVersion.Status.FROZEN
    locked.frozen_by = current_operator
    locked.frozen_at = timezone.now()
    locked.is_current = True
    locked.execution_plan = json.dumps(plan.to_dict(), ensure_ascii=False)
    locked.binding = normalized_binding
    locked.authority_hash = _authority_hash(locked)
    with authority_write(RULESET_FREEZE):
        locked.save(
            update_fields=[
                "status",
                "frozen_by",
                "frozen_at",
                "is_current",
                "execution_plan",
                "binding",
                "authority_hash",
            ],
        )
    AuditLog.objects.create(
        operator=current_operator,
        action_type=AuditLog.ActionType.FINALIZE_RULESET,
        target=f"RulesetVersion:{locked.pk}",
        old_value=json.dumps({"status": old_status}, ensure_ascii=False),
        new_value=json.dumps(
            {
                "status": RulesetVersion.Status.FROZEN,
                "content_hash": locked.content_hash,
                "authority_hash": locked.authority_hash,
                "binding": normalized_binding,
                "error_count": 0,
            },
            ensure_ascii=False,
        ),
    )
    # Everybody who answered the previous version keeps their answers, under the new one.
    _carry_questionnaire_answers(prior, locked, _questionnaire_plan_of(locked))
    return locked


@transaction.atomic
def supersede_ruleset_version(
    version: RulesetVersion, *, created_by, definition: str | None = None
) -> RulesetVersion:
    """Create the next DRAFT version that supersedes a FROZEN one (the editing target).

    §M1-R8: ``is_current`` means *current official authority*, so issuing a Draft editor
    never demotes the running FROZEN authority — the prior FROZEN stays ``is_current``
    until the successor is itself frozen (at which point :func:`freeze_ruleset_version`
    atomically flips authority). The editor finds this successor by ``status=DRAFT``, not
    by ``is_current``. Freezing the successor later re-promotes it to current FROZEN.
    """
    current_operator = require_current_staff(created_by)
    lock_activity_for_action(version.ruleset.activity)
    ContestRuleset.objects.select_for_update().get(pk=version.ruleset_id)
    locked = (
        RulesetVersion.objects.select_for_update()
        .select_related("ruleset__activity")
        .get(pk=version.pk)
    )
    if locked.status != RulesetVersion.Status.FROZEN:
        raise ValidationError("只有已冻结的赛制版本可以被继任覆盖。")
    last = locked.ruleset.versions.order_by("-version").values_list("version", flat=True).first()
    next_version = (last or 0) + 1
    return RulesetVersion.objects.create(
        ruleset=locked.ruleset,
        version=next_version,
        definition=definition if definition is not None else locked.definition,
        binding=locked.binding,
        is_current=False,
        status=RulesetVersion.Status.DRAFT,
        created_by=current_operator,
    )


@transaction.atomic
def create_ruleset_version(
    ruleset: ContestRuleset, *, definition: str, created_by, binding: dict | None = None
) -> RulesetVersion:
    """Create the next version on a ruleset, preserving the one-current invariant.

    §M1-R8: ``is_current`` means *current official authority (FROZEN)*, so a new DRAFT is
    never issued as current and never demotes a running FROZEN authority. An activity with
    only DRAFTs has no current authority until one is frozen (``freeze_ruleset_version``
    then flips authority). Used by ruleset creation and template clones; numbering uses
    ``max(version)+1`` to avoid the unique ``(ruleset, version)`` collision when a ruleset
    — or an activity's ruleset — is cloned repeatedly.
    """
    current_operator = require_current_staff(created_by)
    lock_activity_for_action(ruleset.activity)
    locked = ContestRuleset.objects.select_for_update().get(pk=ruleset.pk)
    last = locked.versions.order_by("-version").values_list("version", flat=True).first()
    next_version = (last or 0) + 1
    return RulesetVersion.objects.create(
        ruleset=locked,
        version=next_version,
        definition=definition,
        binding=dict(binding or {}),
        is_current=False,
        created_by=current_operator,
    )
