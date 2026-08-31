from __future__ import annotations

import hashlib
import json
import re
from decimal import Decimal, InvalidOperation
from typing import Iterable, Mapping

from common.business_rules import ensure_round_unlocked
from common.lifecycle import runtime_approved_singers, runtime_is_test, scope_runtime
from common.models import AuditLog
from common.test_data import lock_activity_for_runtime_data
from core.policies import ActivityAction
from core.services import lock_activity_for_action
from django.core.exceptions import PermissionDenied, ValidationError
from django.db import transaction
from django.db.models import Max, QuerySet
from django.utils import timezone
from ruleset.compiler import ExecutionPlan, compile_version
from ruleset.resolver import (
    ResolveInput,
    ResolverState,
    checkpoint_inputs_fingerprint,
    inputs_fingerprint,
    resolve,
    resolve_to_checkpoint,
    stage_consumed_scopes,
)

from .models import (
    CompositeResult,
    ContestRound,
    Judge,
    ManualDecision,
    Performance,
    RoundEntry,
    RoundJudge,
    ScoreRecord,
    ScoreSummary,
    SingerRegistration,
    StageDecision,
    StageResult,
)


def _eligible_singers(contest_round: ContestRound) -> QuerySet[SingerRegistration]:
    return SingerRegistration.objects.filter(round_entries__round=contest_round).order_by("pk")


def _active_judges(contest_round: ContestRound) -> QuerySet[Judge]:
    return Judge.objects.filter(round_assignments__round=contest_round).order_by("pk")


@transaction.atomic
def prepare_round(contest_round: ContestRound, operator) -> ContestRound:
    locked_activity = lock_activity_for_action(contest_round.activity, ActivityAction.SCORE)
    locked_round = (
        ContestRound.objects.select_for_update().select_related("activity").get(pk=contest_round.pk)
    )
    if locked_round.activity_id != locked_activity.pk:
        raise PermissionDenied("轮次不属于当前活动。")
    if locked_round.status != ContestRound.Status.DRAFT:
        raise ValidationError("比赛轮次只能从草稿状态准备。")

    if locked_round.round_type == ContestRound.RoundType.PRELIMINARY:
        singers = list(runtime_approved_singers(locked_round.activity).order_by("pk"))
    else:
        previous_round = ContestRound.objects.filter(
            activity=locked_round.activity,
            round_type=ContestRound.RoundType.PRELIMINARY,
        ).first()
        if previous_round is None:
            raise ValidationError("后续轮次必须先有上一轮比赛。")
        ensure_round_final_for_advancement(previous_round)
        singers = list(
            scope_runtime(
                SingerRegistration.objects.filter(
                    activity=locked_round.activity,
                    summaries__round=previous_round,
                    summaries__is_advanced=True,
                    summaries__is_test_data=runtime_is_test(locked_round.activity),
                ),
                locked_round.activity,
            ).order_by("pk")
        )

    judges = list(
        Judge.objects.filter(activity=locked_round.activity, is_active=True).order_by("pk")
    )
    if not singers or not judges:
        raise ValidationError("准备比赛轮次需要至少一名选手和一名活跃评委。")

    if locked_round.scoring_mode == ContestRound.ScoringMode.DROP_HIGH_LOW and len(judges) < 3:
        raise ValidationError("当前评分方式至少需要 3 名评委。")

    RoundEntry.objects.bulk_create(
        [RoundEntry(round=locked_round, singer=singer) for singer in singers]
    )
    RoundJudge.objects.bulk_create(
        [RoundJudge(round=locked_round, judge=judge) for judge in judges]
    )
    locked_round.status = ContestRound.Status.PREPARED
    locked_round.is_locked = False
    locked_round.save(update_fields=["status", "is_locked"])
    AuditLog.objects.create(
        operator=operator,
        action_type=AuditLog.ActionType.UPDATE_STATUS,
        target=f"ContestRound:{locked_round.pk}",
        new_value=json.dumps(
            {
                "round": locked_round.pk,
                "status": ContestRound.Status.PREPARED,
                "entries": len(singers),
                "judges": len(judges),
            },
            ensure_ascii=False,
        ),
    )
    return locked_round


@transaction.atomic
def reset_test_round_snapshots(
    contest_round: ContestRound,
    operator,
    *,
    test_only: bool = False,
    owned_singer_ids: set[int],
    owned_judge_ids: set[int],
) -> ContestRound:
    lock_activity_for_runtime_data(contest_round.activity)
    locked_round = (
        ContestRound.objects.select_for_update().select_related("activity").get(pk=contest_round.pk)
    )
    if not test_only:
        raise ValidationError("Test round reset requires explicit test-only opt-in.")
    if not locked_round.activity.is_test_mode:
        raise ValidationError("Only test-mode activities can reset prepared round snapshots.")
    if (
        RoundEntry.objects.filter(round=locked_round)
        .exclude(singer_id__in=owned_singer_ids)
        .exists()
        or RoundEntry.objects.filter(round=locked_round, singer__is_test_data=False).exists()
        or RoundJudge.objects.filter(round=locked_round)
        .exclude(judge_id__in=owned_judge_ids)
        .exists()
    ):
        raise ValidationError("Test reset requires test-owned snapshot parents.")

    old_value = json.dumps(
        {
            "status": locked_round.status,
            "is_locked": locked_round.is_locked,
            "entries": locked_round.entries.count(),
            "judges": locked_round.round_judges.count(),
        },
        ensure_ascii=False,
    )
    locked_round.status = ContestRound.Status.DRAFT
    locked_round.is_locked = False
    locked_round.save(update_fields=["status", "is_locked"])
    RoundEntry.objects.filter(round=locked_round).delete()
    RoundJudge.objects.filter(round=locked_round).delete()
    AuditLog.objects.create(
        operator=operator,
        action_type=AuditLog.ActionType.OTHER,
        target=f"ContestRound:{locked_round.pk}",
        old_value=old_value,
        new_value=json.dumps(
            {"status": ContestRound.Status.DRAFT, "is_locked": False, "entries": 0, "judges": 0},
            ensure_ascii=False,
        ),
        note="Demo test round reset",
    )
    return locked_round


@transaction.atomic
def reset_round_snapshots(
    contest_round: ContestRound, operator, *, reason: str = ""
) -> ContestRound:
    """Reset a round to DRAFT, discarding its score matrix and snapshots.

    For a test-mode activity, every parent carried into the reset must itself be
    test-marked; otherwise a test rehearsal snapshot is silently wiping formal
    rows. A formal activity is intentionally allowed to unwind via this path.
    """
    lock_activity_for_runtime_data(contest_round.activity)
    locked_round = (
        ContestRound.objects.select_for_update().select_related("activity").get(pk=contest_round.pk)
    )
    activity = locked_round.activity
    if activity.is_test_mode and (
        RoundEntry.objects.filter(round=locked_round, singer__is_test_data=False).exists()
        or ScoreRecord.objects.filter(round=locked_round, is_test_data=False).exists()
        or ScoreSummary.objects.filter(round=locked_round, is_test_data=False).exists()
    ):
        raise ValidationError("Test round reset requires test-owned scores and singers.")

    old_value = json.dumps(
        {
            "status": locked_round.status,
            "is_locked": locked_round.is_locked,
            "entries": locked_round.entries.count(),
            "judges": locked_round.round_judges.count(),
        },
        ensure_ascii=False,
    )
    locked_round.status = ContestRound.Status.DRAFT
    locked_round.is_locked = False
    locked_round.save(update_fields=["status", "is_locked"])
    ScoreRecord.objects.filter(round=locked_round).delete()
    ScoreSummary.objects.filter(round=locked_round).delete()
    RoundEntry.objects.filter(round=locked_round).delete()
    RoundJudge.objects.filter(round=locked_round).delete()
    AuditLog.objects.create(
        operator=operator,
        action_type=AuditLog.ActionType.OTHER,
        target=f"ContestRound:{locked_round.pk}",
        old_value=old_value,
        new_value=json.dumps(
            {"status": ContestRound.Status.DRAFT, "is_locked": False, "entries": 0, "judges": 0},
            ensure_ascii=False,
        ),
        note=f"reset_round_snapshots={locked_round.pk} {reason}".strip(),
    )
    return locked_round


@transaction.atomic
def reset_round_to_draft(contest_round: ContestRound, actor, *, reason: str = "") -> ContestRound:
    """Admin-unwind a prepared/scoring/locked round back to DRAFT.

    Rejects when a later round already consumes this round's advancement, since
    resetting upstream would orphan the downstream snapshot. Requires a reason.
    """
    if not reason.strip():
        raise ValidationError("重置轮次必须填写原因。")
    lock_activity_for_runtime_data(contest_round.activity)
    locked_round = (
        ContestRound.objects.select_for_update().select_related("activity").get(pk=contest_round.pk)
    )
    if locked_round.activity.is_locked:
        raise PermissionDenied("活动结果已锁定，无法重置轮次。")
    if locked_round.status == ContestRound.Status.DRAFT:
        return locked_round
    ensure_round_not_consumed_by_confirmed_stage(locked_round)
    round_order = {
        ContestRound.RoundType.PRELIMINARY: 0,
        ContestRound.RoundType.SEMI_FINAL: 1,
    }
    for other in (
        ContestRound.objects.select_for_update()
        .filter(activity=locked_round.activity)
        .exclude(pk=locked_round.pk)
        .order_by("pk")
    ):
        other_rank = round_order[ContestRound.RoundType(other.round_type)]
        this_rank = round_order[ContestRound.RoundType(locked_round.round_type)]
        if other.status != ContestRound.Status.DRAFT and other_rank > this_rank:
            raise ValidationError("后续轮次仍在使用本轮结果，重置前必须先清空后续轮次。")
    return reset_round_snapshots(locked_round, actor, reason=reason)


def downstream_rounds(contest_round: ContestRound) -> QuerySet[ContestRound]:
    """Rounds that consume this round's advancement, if any.

    Only a preliminary round currently feeds a later round.
    """
    if contest_round.round_type == ContestRound.RoundType.PRELIMINARY:
        return ContestRound.objects.filter(
            activity=contest_round.activity,
            round_type=ContestRound.RoundType.SEMI_FINAL,
        )
    return ContestRound.objects.none()


def ensure_round_final_for_advancement(contest_round: ContestRound) -> None:
    """Require a complete, locked upstream round before building downstream.

    A later-round snapshot must never consume a provisional result, or the two
    rounds would hold two different truths for the same advancement decision.
    """
    if contest_round.status != ContestRound.Status.LOCKED or not contest_round.is_locked:
        raise ValidationError("上游轮次尚未锁定，无法生成后续轮次。")
    if not expected_score_cells(contest_round):
        raise ValidationError("上游轮次没有可用的评分矩阵。")
    if missing_score_cells(contest_round):
        raise ValidationError("上游轮次仍有未录完的分数。")
    entry_count = RoundEntry.objects.filter(round=contest_round).count()
    summary_count = ScoreSummary.objects.filter(round=contest_round).count()
    if entry_count == 0 or summary_count != entry_count:
        raise ValidationError("上游轮次晋级名单不完整。")
    if ScoreSummary.objects.filter(round=contest_round, rank__lte=0).exists():
        raise ValidationError("上游轮次存在无效排名。")
    if contest_round.advancement_status == ContestRound.AdvancementStatus.NEEDS_REVIEW:
        raise ValidationError("上游轮次晋级名单存在同分，请先人工核定晋级人选。")


def validate_score(value: object) -> Decimal:
    if isinstance(value, bool) or value is None:
        raise ValidationError("分数必须是 0 到 100 之间的数字。")
    try:
        score = Decimal(str(value).strip())
    except (AttributeError, InvalidOperation, ValueError):
        raise ValidationError("分数必须是 0 到 100 之间的数字。") from None
    if not score.is_finite() or score < 0 or score > 100:
        raise ValidationError("分数必须是 0 到 100 之间的数字。")
    if max(0, -int(score.as_tuple().exponent)) > 2:
        raise ValidationError("分数最多保留两位小数。")
    return score


def expected_score_cells(contest_round: ContestRound) -> list[tuple[int, int]]:
    singers = list(_eligible_singers(contest_round).values_list("pk", flat=True))
    judges = list(_active_judges(contest_round).values_list("pk", flat=True))
    return [(singer_id, judge_id) for singer_id in singers for judge_id in judges]


def missing_score_cells(contest_round: ContestRound) -> list[dict[str, int | str]]:
    singers = list(_eligible_singers(contest_round))
    judges = list(_active_judges(contest_round))
    existing = set(
        ScoreRecord.objects.filter(round=contest_round).values_list("singer_id", "judge_id")
    )
    return [
        {
            "singer_id": singer.pk,
            "singer_name": singer.name,
            "judge_id": judge.pk,
            "judge_name": judge.name,
        }
        for singer in singers
        for judge in judges
        if (singer.pk, judge.pk) not in existing
    ]


def ensure_score_records_belong_to_round(
    contest_round: ContestRound, pairs: Iterable[tuple[int, int]]
) -> None:
    singer_ids = set(_eligible_singers(contest_round).values_list("pk", flat=True))
    judge_ids = set(_active_judges(contest_round).values_list("pk", flat=True))
    for singer_id, judge_id in pairs:
        if singer_id not in singer_ids or judge_id not in judge_ids:
            raise ValidationError("选手和评委必须属于当前比赛活动。")


def recalculate_round(contest_round: ContestRound) -> None:
    missing = missing_score_cells(contest_round)
    if missing:
        ScoreSummary.objects.filter(round=contest_round).delete()
        if contest_round.advancement_status != ContestRound.AdvancementStatus.AUTO:
            contest_round.advancement_status = ContestRound.AdvancementStatus.AUTO
            contest_round.save(update_fields=["advancement_status"])
        return

    singers = _eligible_singers(contest_round)
    judge_ids = _active_judges(contest_round).values_list("pk", flat=True)
    for singer in singers:
        singer_scores = list(
            ScoreRecord.objects.filter(
                round=contest_round, singer=singer, judge_id__in=judge_ids
            ).values_list("score", flat=True)
        )
        if (
            contest_round.scoring_mode == ContestRound.ScoringMode.DROP_HIGH_LOW
            and len(singer_scores) >= 3
        ):
            singer_scores.remove(max(singer_scores))
            singer_scores.remove(min(singer_scores))
        average = sum(singer_scores, Decimal("0")) / len(singer_scores)
        ScoreSummary.objects.update_or_create(
            round=contest_round,
            singer=singer,
            defaults={
                "average_score": average,
                "is_test_data": contest_round.activity.is_test_mode,
            },
        )

    ScoreSummary.objects.filter(round=contest_round).exclude(singer__in=singers).delete()
    summaries = list(
        ScoreSummary.objects.filter(round=contest_round).order_by("-average_score", "singer_id")
    )
    advance_count = contest_round.advance_count
    tie_at_boundary = False
    if advance_count and advance_count < len(summaries):
        boundary_score = summaries[advance_count - 1].average_score
        following_score = summaries[advance_count].average_score
        tie_at_boundary = boundary_score == following_score
    for rank, summary in enumerate(summaries, start=1):
        summary.rank = rank
        summary.is_advanced = bool(advance_count and rank <= advance_count)
        summary.save(update_fields=["rank", "is_advanced"])

    new_status = (
        ContestRound.AdvancementStatus.NEEDS_REVIEW
        if tie_at_boundary
        else ContestRound.AdvancementStatus.AUTO
    )
    if contest_round.advancement_status != new_status:
        contest_round.advancement_status = new_status
        contest_round.save(update_fields=["advancement_status"])


@transaction.atomic
def finalize_advancement(
    contest_round: ContestRound,
    selected_singer_ids: Iterable[int],
    actor,
    *,
    note: str = "",
) -> ContestRound:
    """Record a staff-confirmed advancement selection after a boundary tie.

    The score matrix computes a rank-based proposal, but when two singers tie at
    the advancement boundary the system must not silently break the tie by
    database order. Staff explicitly choose who advances; that choice is frozen
    for downstream round consumption and audited.
    """
    lock_activity_for_action(contest_round.activity, ActivityAction.SCORE)
    locked_round = (
        ContestRound.objects.select_for_update().select_related("activity").get(pk=contest_round.pk)
    )
    if locked_round.status == ContestRound.Status.DRAFT:
        raise ValidationError("请先准备并完成比赛轮次后再核定晋级名单。")
    ensure_round_unlocked(locked_round)
    if missing_score_cells(locked_round):
        raise ValidationError("评分尚未完成，无法核定晋级名单。")
    entrants = set(_eligible_singers(locked_round).values_list("pk", flat=True))
    selected = {int(singer_id) for singer_id in selected_singer_ids}
    if not selected:
        raise ValidationError("请选择至少一名晋级选手。")
    if not selected <= entrants:
        raise ValidationError("晋级选手必须属于当前轮次。")
    advance_count = locked_round.advance_count
    if advance_count and len(selected) != advance_count:
        raise ValidationError(f"晋级核定人数必须等于该轮晋级名额（{advance_count} 人）。")

    old_advanced = set(
        ScoreSummary.objects.filter(round=locked_round, is_advanced=True).values_list(
            "singer_id", flat=True
        )
    )
    if (
        selected == old_advanced
        and locked_round.advancement_status == ContestRound.AdvancementStatus.FINALIZED
    ):
        return locked_round

    ScoreSummary.objects.filter(round=locked_round).update(is_advanced=False)
    ScoreSummary.objects.filter(round=locked_round, singer_id__in=selected).update(is_advanced=True)
    locked_round.advancement_status = ContestRound.AdvancementStatus.FINALIZED
    locked_round.save(update_fields=["advancement_status"])
    AuditLog.objects.create(
        operator=actor,
        action_type=AuditLog.ActionType.FINALIZE_ADVANCEMENT,
        target=f"ContestRound:{locked_round.pk}",
        old_value=json.dumps({"advanced": sorted(old_advanced)}, ensure_ascii=False),
        new_value=json.dumps({"advanced": sorted(selected)}, ensure_ascii=False),
        note=note,
    )
    return locked_round


@transaction.atomic
def apply_scores(
    contest_round: ContestRound,
    score_values: Mapping[tuple[int, int], object],
    operator,
    *,
    note: str = "",
) -> list[dict[str, int | str | None]]:
    lock_activity_for_action(contest_round.activity, ActivityAction.SCORE)
    locked_round = (
        ContestRound.objects.select_for_update().select_related("activity").get(pk=contest_round.pk)
    )
    if locked_round.status == ContestRound.Status.DRAFT:
        raise ValidationError("请先准备比赛轮次后再评分。")
    if locked_round.status == ContestRound.Status.LOCKED:
        raise ValidationError("该比赛轮次已锁定。")
    if locked_round.is_locked or locked_round.activity.is_locked:
        raise ValidationError("该比赛轮次或活动已锁定。")

    pairs = list(score_values)
    ensure_score_records_belong_to_round(locked_round, pairs)
    normalized = {pair: validate_score(value) for pair, value in score_values.items()}
    changes: list[dict[str, int | str | None]] = []
    for (singer_id, judge_id), score in normalized.items():
        record = ScoreRecord.objects.filter(
            round=locked_round, singer_id=singer_id, judge_id=judge_id
        ).first()
        old_score = record.score if record else None
        if (
            record is not None
            and record.score == score
            and record.is_test_data == locked_round.activity.is_test_mode
        ):
            continue
        ScoreRecord.objects.update_or_create(
            round=locked_round,
            singer_id=singer_id,
            judge_id=judge_id,
            defaults={
                "score": score,
                "is_test_data": locked_round.activity.is_test_mode,
            },
        )
        changes.append(
            {
                "singer": singer_id,
                "judge": judge_id,
                "old": str(old_score) if old_score is not None else None,
                "new": str(score),
            }
        )

    recalculate_round(locked_round)
    if changes:
        if locked_round.status == ContestRound.Status.PREPARED:
            locked_round.status = ContestRound.Status.SCORING
        locked_round.score_version += 1
        locked_round.save(update_fields=["status", "score_version"])
        AuditLog.objects.create(
            operator=operator,
            action_type=AuditLog.ActionType.ENTER_SCORE,
            target=f"ContestRound:{locked_round.pk}",
            new_value=json.dumps(
                {"round": locked_round.pk, "changes": changes}, ensure_ascii=False
            ),
            note=note,
        )
    return changes


class StaleScoreVersionError(Exception):
    """Raised when a rapid-entry save's ``base_version`` no longer matches the round.

    Signals a stale editor so the caller can surface a 409 and a fresh grid instead of
    silently overwriting another staff member's column.
    """

    def __init__(self, current_version: int):
        self.current_version = current_version
        super().__init__(f"评分已过期，当前版本为 {current_version}。")


@transaction.atomic
def apply_scores_if_version(
    round_id: int,
    base_version: int | None,
    score_values: Mapping[tuple[int, int], object],
    operator,
    *,
    note: str = "",
) -> dict:
    """Apply a sparse cell save under the M0 Activity→Round lock order (M1-H).

    The version check, score application, and version bump all happen inside one
    transaction that takes the Activity lock first, then the ContestRound lock — never
    ``Round → Activity``. A ``base_version`` mismatch raises
    :class:`StaleScoreVersionError` (409) rather than being written over. Returns the
    new ``score_version`` and whether the matrix is now complete.
    """
    if base_version is None:
        raise ValidationError("缺少 base_version。")
    contest_round = ContestRound.objects.get(pk=round_id)
    lock_activity_for_action(contest_round.activity, ActivityAction.SCORE)
    locked_round = (
        ContestRound.objects.select_for_update().select_related("activity").get(pk=round_id)
    )
    if locked_round.status == ContestRound.Status.DRAFT:
        raise ValidationError("请先准备比赛轮次后再录入评分。")
    if int(base_version) != locked_round.score_version:
        raise StaleScoreVersionError(locked_round.score_version)
    apply_scores(locked_round, score_values, operator, note=note)
    locked_round.refresh_from_db()
    return {
        "version": locked_round.score_version,
        "matrix_complete": not missing_score_cells(locked_round),
    }


@transaction.atomic
def lock_round(contest_round: ContestRound, operator) -> ContestRound:
    """Freeze a prepared/scoring round once its score matrix is complete."""
    lock_activity_for_action(contest_round.activity, ActivityAction.SCORE)
    locked_round = (
        ContestRound.objects.select_for_update().select_related("activity").get(pk=contest_round.pk)
    )
    if (
        locked_round.status not in {ContestRound.Status.PREPARED, ContestRound.Status.SCORING}
        or locked_round.is_locked
    ):
        raise PermissionDenied("该比赛轮次已锁定。")
    if not expected_score_cells(locked_round):
        raise PermissionDenied("当前轮次没有可锁定的完整评分矩阵。")
    if missing_score_cells(locked_round):
        raise PermissionDenied("仍有未完成的评委评分，不能锁定结果。")
    if locked_round.advancement_status == ContestRound.AdvancementStatus.NEEDS_REVIEW:
        raise PermissionDenied("晋级线存在同分，请先人工核定晋级名单。")
    locked_round.is_locked = True
    locked_round.status = ContestRound.Status.LOCKED
    locked_round.save(update_fields=["is_locked", "status"])
    AuditLog.objects.create(
        operator=operator,
        action_type=AuditLog.ActionType.RELOCK_RESULT,
        target=f"ContestRound:{locked_round.pk}",
        old_value="unlocked",
        new_value="locked",
    )
    return locked_round


@transaction.atomic
def unlock_round(contest_round: ContestRound, actor, *, note: str = "") -> ContestRound:
    """Unlock an upstream locked round only if no downstream round consumes it."""
    lock_activity_for_action(contest_round.activity)
    locked_round = (
        ContestRound.objects.select_for_update().select_related("activity").get(pk=contest_round.pk)
    )
    if locked_round.status != ContestRound.Status.LOCKED or not locked_round.is_locked:
        raise PermissionDenied("该比赛轮次未锁定。")
    ensure_round_not_consumed_by_confirmed_stage(locked_round)
    for other in (
        ContestRound.objects.select_for_update()
        .filter(activity=locked_round.activity, pk__in=downstream_rounds(locked_round))
        .order_by("pk")
    ):
        if other.status != ContestRound.Status.DRAFT:
            raise PermissionDenied("后续轮次仍在使用本轮结果，解锁前必须先清空后续轮次。")
    locked_round.is_locked = False
    locked_round.status = ContestRound.Status.SCORING
    locked_round.save(update_fields=["is_locked", "status"])
    AuditLog.objects.create(
        operator=actor,
        action_type=AuditLog.ActionType.UNLOCK_RESULT,
        target=f"ContestRound:{locked_round.pk}",
        old_value="locked",
        new_value="unlocked",
        note=note,
    )
    return locked_round


_META_SHEET_NAME = "ArtFlowMeta"
_SCORE_WORKBOOK_SCHEMA_VERSION = "1"
# §35: when the ArtFlowMeta sheet is present, every field is mandatory. A missing
# field means the metadata was damaged or hand-edited — the importer must reject
# rather than fail-open into the legacy name parser and import the wrong rows.
_META_REQUIRED_KEYS = (
    "schema_version",
    "activity_id",
    "round_id",
    "entry_ids",
    "judge_ids",
    "snapshot_fingerprint",
)


def _read_artflow_meta(workbook) -> dict[str, str] | None:
    """Return the meta sheet as a dict, or ``None`` when the sheet is entirely absent.

    ``None`` (no ArtFlowMeta sheet) is the only signal that lets a workbook take the
    explicit legacy name-based import path. A present-but-empty sheet yields ``{}``
    so the caller treats it as metadata present but incomplete → reject.
    """
    if _META_SHEET_NAME not in workbook.sheetnames:
        return None
    meta_worksheet = workbook[_META_SHEET_NAME]
    data: dict[str, str] = {}
    for row in meta_worksheet.iter_rows(values_only=True):
        if not row or len(row) < 2 or row[0] is None:
            continue
        key = str(row[0]).strip()
        value = row[1]
        if key:
            data[key] = str(value).strip() if value is not None else ""
    return data


def _split_ids(value: str | None) -> list[str]:
    if not value:
        return []
    return [token for token in (str(value).strip().split(",")) if token]


def snapshot_fingerprint(
    *,
    schema_version: str,
    activity_id,
    round_id,
    ruleset_version: str,
    entry_ids: list[str],
    judge_ids: list[str],
) -> str:
    """Deterministic fingerprint of the snapshot a score workbook was built from.

    Any drift in the rosters or the bound ruleset (or tampering with the meta
    sheet) changes the fingerprint, so the importer can reject a stale or edited
    workbook outright with zero partial mutation.
    """
    payload = json.dumps(
        {
            "schema_version": str(schema_version),
            "activity_id": str(activity_id),
            "round_id": str(round_id),
            "ruleset_version": str(ruleset_version or ""),
            "entry_ids": [str(x) for x in entry_ids],
            "judge_ids": [str(x) for x in judge_ids],
        },
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _version_binding(version) -> dict:
    """The frozen version's binding snapshot, falling back to the ruleset for legacy data.

    A frozen version is self-authoritative: once bound at freeze, the runtime reads the
    binding from the version and never from the still-mutable :class:`ContestRuleset`
    fields. Pre-R1 frozen versions carried no snapshot, so we fall back to the ruleset's
    fields — the data migration backfills those, and this fallback only survives for
    unmigrated rows.
    """
    binding = version.binding or {}
    if not binding.get("stage_key") and not binding.get("round_keys"):
        ruleset = version.ruleset
        if ruleset.round_keys or ruleset.stage_key:
            binding = {
                "stage_key": ruleset.stage_key or "",
                "round_keys": dict(ruleset.round_keys or {}),
                "vote_keys": dict(ruleset.vote_keys or {}),
                "group_keys": dict(ruleset.group_keys or {}),
                "announcement_blocks": list(ruleset.announcement_blocks or []),
                "announcement_blocks_by_checkpoint": dict(
                    ruleset.announcement_blocks_by_checkpoint or {}
                ),
            }
    return binding


def bound_ruleset_version_label(contest_round: ContestRound) -> str:
    """Label the frozen ruleset version bound to a round via its binding snapshot, if any."""
    from ruleset.models import ContestRuleset, RulesetVersion

    for ruleset in ContestRuleset.objects.filter(activity_id=contest_round.activity_id):
        version = (
            ruleset.versions.filter(is_current=True, status=RulesetVersion.Status.FROZEN)
            .order_by("-version")
            .first()
        )
        binding = _version_binding(version) if version is not None else {}
        if not binding.get("round_keys"):
            binding = {"round_keys": dict(ruleset.round_keys or {})}
        for round_pk in binding.get("round_keys", {}).values():
            if str(round_pk) == str(contest_round.pk):
                return f"{ruleset.pk}.{version.version}" if version else f"{ruleset.pk}.draft"
    return ""


def _resolve_judge_header(
    header: str, judge_by_id: dict[int, Judge], judge_by_name: dict[str, Judge]
) -> Judge | None:
    header = header.strip()
    if not header:
        return None
    match = re.match(r"^J(\d+)\b", header)
    if match:
        return judge_by_id.get(int(match.group(1)))
    return judge_by_name.get(header)


def _parse_id_authority_workbook(rows, headers, meta, contest_round: ContestRound):
    """Parse a workbook generated with its ArtFlowMeta sheet.

    Singer and judge IDs are the authority; the name column is only a hint and
    is never used for lookup. A mismatched activity/round is rejected outright.
    """
    errors: list[str] = []
    if meta.get("activity_id") and str(contest_round.activity_id) != meta["activity_id"]:
        errors.append("评分表属于其他活动。")
    if meta.get("round_id") and str(contest_round.pk) != meta["round_id"]:
        errors.append("评分表属于其他轮次。")

    if meta.get("schema_version") and meta["schema_version"] != _SCORE_WORKBOOK_SCHEMA_VERSION:
        errors.append(f"评分表 schema_version 不受支持（{meta['schema_version']}）。")

    active_judges = list(_active_judges(contest_round))
    judge_by_id = {judge.pk: judge for judge in active_judges}
    judge_by_name = {judge.name: judge for judge in active_judges}
    singers = {singer.pk: singer for singer in _eligible_singers(contest_round)}

    meta_entries = _split_ids(meta.get("entry_ids"))
    current_entries = sorted(str(pk) for pk in singers)
    if meta_entries and set(current_entries) != set(meta_entries):
        errors.append("评分表选手名单过期或与当前轮次不一致。")

    meta_judges = _split_ids(meta.get("judge_ids"))
    current_judges = sorted(str(pk) for pk in judge_by_id)
    if meta_judges and set(current_judges) != set(meta_judges):
        errors.append("评分表评委名单过期或与当前轮次不一致。")

    if meta.get("ruleset_version"):
        bound = bound_ruleset_version_label(contest_round)
        if bound and meta["ruleset_version"] != bound:
            errors.append("评分表所属赛制版本已过期。")

    if meta.get("snapshot_fingerprint"):
        expected = snapshot_fingerprint(
            schema_version=meta.get("schema_version", _SCORE_WORKBOOK_SCHEMA_VERSION),
            activity_id=meta.get("activity_id", str(contest_round.activity_id)),
            round_id=meta.get("round_id", str(contest_round.pk)),
            ruleset_version=meta.get("ruleset_version", ""),
            entry_ids=meta_entries,
            judge_ids=meta_judges,
        )
        if expected != meta["snapshot_fingerprint"]:
            errors.append("评分表指纹不匹配（快照已过期或被修改）。")

    valid_judges: dict[int, Judge] = {}
    for column in range(2, len(headers)):
        header = headers[column]
        if not header:
            continue
        judge = _resolve_judge_header(header, judge_by_id, judge_by_name)
        if judge is None:
            errors.append(f"第 {column + 1} 列评委不存在: {header}")
        else:
            valid_judges[column] = judge

    scores = {}
    for row_number, row in enumerate(rows, start=2):
        if not row:
            continue
        singer_value = row[0] if len(row) > 0 else None
        try:
            singer_id = int(str(singer_value).strip()) if singer_value is not None else None
        except (TypeError, ValueError):
            singer_id = None
        if singer_id is None or singer_id not in singers:
            errors.append(f"第 {row_number} 行选手不属于当前轮次: {singer_value}")
            continue
        for column, score_value in enumerate(row[2:], start=2):
            if score_value is None or str(score_value).strip() == "":
                continue
            judge = valid_judges.get(column)
            if judge is None:
                errors.append(f"第 {row_number} 行存在没有评委标题的分数。")
                continue
            pair = (singer_id, judge.pk)
            if pair in scores:
                errors.append(f"分数重复: 选手{singer_id} {judge.name}")
                continue
            try:
                scores[pair] = validate_score(score_value)
            except ValidationError as error:
                errors.extend(
                    f"第 {row_number} 行分数错误: 选手{singer_id} {judge.name} ({message})"
                    for message in error.messages
                )
    return scores, errors


def _parse_name_based_workbook(rows, headers, contest_round: ContestRound):
    """Legacy fallback that matches singers and judges by exact name only."""
    judge_names = headers[1:]
    duplicate_judge_names = {name for name in judge_names if name and judge_names.count(name) > 1}
    errors = [f"评委姓名重复: {name}" for name in sorted(duplicate_judge_names)]
    judges_by_name = {
        judge.name: judge
        for judge in _active_judges(contest_round)
        if judge.name not in duplicate_judge_names
    }
    singers = list(_eligible_singers(contest_round))
    singer_names = {singer.name for singer in singers}
    duplicate_singer_names = {
        name for name in singer_names if sum(singer.name == name for singer in singers) > 1
    }
    errors.extend(f"选手姓名重复: {name}" for name in sorted(duplicate_singer_names))
    singer_by_name = {
        singer.name: singer for singer in singers if singer.name not in duplicate_singer_names
    }
    scores = {}
    for row_number, row in enumerate(rows, start=2):
        if not row:
            continue
        singer_value = row[0] if len(row) > 0 else None
        singer_name = str(singer_value).strip() if singer_value is not None else ""
        if not singer_name:
            continue
        singer = singer_by_name.get(singer_name)
        if singer is None:
            errors.append(f"第 {row_number} 行选手不存在或姓名不唯一: {singer_name}")
            continue
        for column, score_value in enumerate(row[1:], start=1):
            if score_value is None or str(score_value).strip() == "":
                continue
            if column >= len(headers) or not headers[column]:
                errors.append(f"第 {row_number} 行存在没有评委标题的分数。")
                continue
            judge_name = headers[column]
            judge = judges_by_name.get(judge_name)
            if judge is None:
                errors.append(f"第 {row_number} 列评委不存在或姓名不唯一: {judge_name}")
                continue
            pair = (singer.pk, judge.pk)
            if pair in scores:
                errors.append(f"分数重复: {singer_name} {judge_name}")
                continue
            try:
                scores[pair] = validate_score(score_value)
            except ValidationError as error:
                errors.extend(
                    f"第 {row_number} 行分数错误: {singer_name} {judge_name} ({message})"
                    for message in error.messages
                )
    return scores, errors


def parse_score_workbook(uploaded_file, contest_round: ContestRound):
    from openpyxl import load_workbook

    workbook = load_workbook(uploaded_file, data_only=True, read_only=True)
    worksheet = workbook.active
    if worksheet is None:
        return {}, ["评分表没有工作表。"]
    rows = worksheet.iter_rows(values_only=True)
    try:
        header_row = next(rows)
    except StopIteration:
        return {}, ["评分表不能为空。"]

    headers = [str(value).strip() if value is not None else "" for value in header_row]
    if not headers or not headers[0]:
        return {}, ["评分表第一列必须是选手姓名。"]

    meta = _read_artflow_meta(workbook)
    if meta is not None:
        # ArtFlowMeta present → the id-authority path is mandatory, not a choice.
        # Any missing field (incl. round_id) previously downgraded to the name parser;
        # §35 demands a hard reject instead so a tampered sheet can never import wrong rows.
        missing = [key for key in _META_REQUIRED_KEYS if not meta.get(key)]
        if missing:
            return {}, [
                "评分表 ArtFlowMeta 缺失必需字段: "
                + ", ".join(missing)
                + "（拒绝降级为姓名导入）。"
            ]
        return _parse_id_authority_workbook(rows, headers, meta, contest_round)
    # No ArtFlowMeta sheet → explicit legacy name-based import (unchanged).
    return _parse_name_based_workbook(rows, headers, contest_round)


# --- M1-F: bind a frozen ruleset to the database, resolve, and persist. ---------


def bind_resolve_input(
    version,
    activity,
    *,
    round_keys: Mapping[str, ContestRound],
    vote_scores=None,
    group_of=None,
    manual=None,
) -> ResolveInput:
    """Load a :class:`ResolveInput` from the DB for a frozen ruleset.

    The roster is the activity's approved singers (runtime-scoped, canonical pk
    order). Round scores are read raw from :class:`ScoreRecord` grouped
    round -> singer -> judge scores, so the engine owns the scoring mode. Vote
    scores arrive already normalized (§16.9): the caller supplies the single
    Decimal per contestant — the binder never re-derives a raw-vote score.
    """
    roster = tuple(
        str(pk)
        for pk in scope_runtime(
            SingerRegistration.objects.filter(
                activity=activity,
                pre_status=SingerRegistration.PreStatus.APPROVED,
            ).order_by("pk"),
            activity,
        ).values_list("pk", flat=True)
    )
    round_scores = {}
    for rkey, contest_round in round_keys.items():
        grouped: dict[str, list[Decimal]] = {}
        records = (
            ScoreRecord.objects.filter(round=contest_round)
            .select_related("singer", "judge")
            .order_by("singer_id", "judge__pk")
        )
        for rec in records:
            grouped.setdefault(str(rec.singer_id), []).append(rec.score)
        round_scores[rkey] = {k: tuple(v) for k, v in grouped.items()}
    return ResolveInput(
        roster=roster,
        round_scores=round_scores,
        vote_scores=vote_scores or {},
        group_of=group_of or {},
        manual=manual or {},
    )


def _source_group_of(activity, binding) -> dict[str, dict[str, str]]:
    """Source the ``group_of`` ResolveInput from the binding's ``group_keys``.

    Each ``by`` key resolves to a ContestRound; a singer's group is the
    ``PerformanceGroup`` of their ``Performance`` in that round.
    """
    group_keys = binding.get("group_keys") or {}
    if not group_keys:
        return {}
    out: dict[str, dict[str, str]] = {}
    for by, round_pk in group_keys.items():
        perfs = Performance.objects.filter(round_id=round_pk, group__isnull=False).select_related(
            "group"
        )
        out[by] = {str(p.singer_id): p.group.name for p in perfs}
    return out


def _source_vote_scores(activity, binding) -> dict[str, dict[str, Decimal]]:
    """Source the ``vote_scores`` ResolveInput from the binding's ``vote_keys``.

    Each ``vote_source`` key resolves to a VoteSession. Per-singer vote share is
    scaled to a 0-10 audience score (§16.9 "10分制 audience score"): ``10 * n / total``.
    An empty session is left unbound so the resolver holds rather than fabricates.
    """
    from voting.models import VoteRecord

    vote_keys = binding.get("vote_keys") or {}
    if not vote_keys:
        return {}
    test_flag = runtime_is_test(activity)
    out: dict[str, dict[str, Decimal]] = {}
    for source, vs_pk in vote_keys.items():
        counts: dict[str, int] = {}
        total = 0
        records = VoteRecord.objects.filter(
            vote_session_id=vs_pk, is_test_data=test_flag
        ).select_related("vote_option")
        for rec in records:
            sid = str(rec.vote_option.singer_id)
            counts[sid] = counts.get(sid, 0) + 1
            total += 1
        if not total:
            continue
        out[source] = {
            sid: (Decimal(10) * Decimal(n) / Decimal(total)).quantize(Decimal("0.01"))
            for sid, n in counts.items()
        }
    return out


def _source_manual(version, activity) -> dict[str, dict[str, tuple[str, ...]]]:
    """Source the ``manual`` ResolveInput from the version's ManualDecision rows.

    Returns ``{manual_key: {group_or_empty: tuple_of_chosen_pks}}`` so the resolver's
    group (and flat ``""``) MANUAL_SELECT paths both read it directly.
    """
    decisions = ManualDecision.objects.filter(ruleset_version=version, activity=activity).order_by(
        "manual_key", "group", "pk"
    )
    out: dict[str, dict[str, tuple[str, ...]]] = {}
    for d in decisions:
        out.setdefault(d.manual_key, {})[d.group] = tuple(str(c) for c in (d.chosen or []))
    return out


def _plan_from_version(version) -> ExecutionPlan:
    if version.execution_plan:
        return ExecutionPlan.from_dict(json.loads(version.execution_plan))
    report, plan = compile_version(version)
    if not report.passes():
        raise ValidationError("无法解析无效赛制版本。")
    return plan


# The resolver is a pure "machine computed" verdict. A resolved result is only
# "ready to confirm" (§36-37); it becomes final/locked when a staff member 核定.
_RESOLVER_STATUS = {
    ResolverState.HOLD: StageResult.Status.HOLD,
    ResolverState.REVIEW: StageResult.Status.REVIEW,
    ResolverState.READY: StageResult.Status.READY_TO_CONFIRM,
}


@transaction.atomic
def persist_stage_result(version, activity, result, *, stage_key, computed_by):
    """Write a :class:`ResolveResult` into StageResult + decisions + composites.

    Idempotency + versioning: the identity is ``(ruleset_version, input_fingerprint)``
    (the immutable authority, so two versions with the same definition but different
    binding never collide). Recomputing the same frozen ruleset over the same raw facts
    reuses the existing StageResult (a CONFIRMED one is returned as-is since it is
    immutable); any input change produces a new input_fingerprint and therefore a new
    versioned StageResult
    whose ``result_version`` is one past the stage's latest. This is what makes repeated
    recompute safe (no IntegrityError, no silent overwrite of a published result).
    """
    if version.ruleset.activity_id != activity.pk:
        raise ValidationError("Ruleset version must belong to the result activity.")
    is_test = runtime_is_test(activity)
    singer_by_key = {str(s.pk): s for s in SingerRegistration.objects.filter(activity=activity)}
    missing = [d.contestant for d in result.decisions if d.contestant not in singer_by_key]
    if missing:
        raise ValidationError(f"无法将结果写回选手：{missing}")

    # Identity is the immutable RulesetVersion (not the definition-only content_hash):
    # two versions with the same definition but different binding no longer collide
    # (P0-3). The authority_hash is retained for audit / external alignment.
    authority_hash = getattr(version, "authority_hash", "") or result.content_hash
    fingerprint = result.input_fingerprint
    status = _RESOLVER_STATUS.get(result.status)
    if status is None:
        raise ValidationError(f"无法映射解析器状态：{result.status}")
    existing = StageResult.objects.filter(
        activity=activity,
        stage_key=stage_key,
        ruleset_version=version,
        input_fingerprint=fingerprint,
    ).first()
    if existing is not None:
        if existing.status == StageResult.Status.CONFIRMED:
            return existing
        # Identical facts over a still-mutable (HOLD/REVIEW/READY_TO_CONFIRM) row:
        # refresh in place. A CONFIRMED stage is immutable and protected by the
        # queryset guard, so it is never reached here (identical input → same status).
        existing.status = status
        existing.reasons = list(result.reasons)
        existing.created_by = computed_by
        existing.save(update_fields=["status", "reasons", "created_by"])
        StageDecision.objects.filter(stage_result=existing).delete()
        CompositeResult.objects.filter(stage_result=existing).delete()
        _create_children(existing, result, singer_by_key, is_test)
        return existing

    last_version = (
        StageResult.objects.filter(activity=activity, stage_key=stage_key).aggregate(
            m=Max("result_version")
        )["m"]
        or 0
    )
    stage = StageResult.objects.create(
        activity=activity,
        ruleset_version=version,
        created_by=computed_by,
        stage_key=stage_key,
        status=status,
        reasons=list(result.reasons),
        ruleset_hash=authority_hash,
        input_fingerprint=fingerprint,
        schema_version=result.schema_version,
        plan_version=result.plan_version,
        result_version=last_version + 1,
        is_test_data=is_test,
    )
    _create_children(stage, result, singer_by_key, is_test)
    return stage


def _create_children(stage, result, singer_by_key, is_test):
    """Bulk-create a result's decisions + composites onto a stage result."""
    StageDecision.objects.bulk_create(
        [
            StageDecision(
                stage_result=stage,
                singer=singer_by_key[d.contestant],
                outcome_code=d.outcome_code.value,
                source_node=d.source_node,
                rank=d.rank,
                score=d.score,
                reason=d.reason,
                is_test_data=is_test,
            )
            for d in result.decisions
        ]
    )
    CompositeResult.objects.bulk_create(
        [
            CompositeResult(
                stage_result=stage,
                singer=singer_by_key[c.contestant],
                node_key=c.node_key,
                value=c.value,
                components=[
                    {
                        "source": source,
                        "weight": str(weight),
                        "value": str(value),
                        "contribution": str(contribution),
                    }
                    for (source, weight, value, contribution) in c.components
                ],
                is_test_data=is_test,
            )
            for c in result.composites
            if c.contestant in singer_by_key
        ]
    )


def _definition_checkpoint_keys(definition) -> set[str]:
    obj = definition if isinstance(definition, dict) else json.loads(definition)
    return {c["key"] for c in (obj.get("checkpoints") or ())}


def _stage_is_checkpoint(version, stage_key: str) -> bool:
    """True when ``stage_key`` names a declared checkpoint in the frozen definition."""
    return stage_key in _definition_checkpoint_keys(version.definition)


def _bound_inputs(version, activity) -> tuple[ResolveInput, dict]:
    """Rebuild the current :class:`ResolveInput` from the frozen version's binding.

    This is the authority reference for staleness re-checking: it re-reads the raw
    facts (round scores, vote counts, group map, manual picks) exactly as the runtime
    would today. The version's frozen binding drives which rounds/votes/groups are read,
    so a binding-only change already alters the recomputed fingerprint.
    """
    binding = _version_binding(version)
    raw_keys = binding.get("round_keys") or {}
    round_ids = list(raw_keys.values())
    rounds = {r.pk: r for r in ContestRound.objects.filter(pk__in=round_ids, activity=activity)}
    bound = {key: rounds[rid] for key, rid in raw_keys.items()}
    inputs = bind_resolve_input(
        version,
        activity,
        round_keys=bound,
        vote_scores=_source_vote_scores(activity, binding),
        group_of=_source_group_of(activity, binding),
        manual=_source_manual(version, activity),
    )
    return inputs, binding


def _current_input_fingerprint(version, activity, stage_key: str) -> str:
    """The input fingerprint the current raw facts would produce for this stage.

    Checkpoint stages scope the projection to the closure's consumed keys (so future
    stages never shift an earlier stage's identity); full (non-checkpoint) stages use
    the whole-input fingerprint. A mismatch against a stored ``input_fingerprint`` means
    the result is stale.
    """
    inputs, _ = _bound_inputs(version, activity)
    if _stage_is_checkpoint(version, stage_key):
        return checkpoint_inputs_fingerprint(version.definition, inputs, stage_key)
    return inputs_fingerprint(inputs)


def _ensure_stage_dependencies_final(version, activity, stage_key: str) -> None:
    """Require the raw facts a stage consumed to be at rest before it can be frozen.

    A CONFIRMED stage is the point of no return, so the scores it read must already be
    locked. Round sources require the bound :class:`ContestRound` to be locked; vote
    sources require the bound :class:`VoteSession` to be locked. Group maps are a view
    over a round, so their round lock is covered above.
    """
    from voting.models import VoteSession

    binding = _version_binding(version)
    checkpoint = stage_key if _stage_is_checkpoint(version, stage_key) else None
    round_keys, vote_keys, _, _ = stage_consumed_scopes(version.definition, checkpoint)
    bound_round_ids = [
        rid for k, rid in (binding.get("round_keys") or {}).items() if k in round_keys
    ]
    if bound_round_ids:
        open_rounds = ContestRound.objects.filter(
            pk__in=bound_round_ids, activity=activity
        ).exclude(is_locked=True)
        if open_rounds.exists():
            raise ValidationError("该赛段依赖的淘汰轮次尚未锁定，请先锁定轮次后再核定。")
    bound_vote_ids = [vid for k, vid in (binding.get("vote_keys") or {}).items() if k in vote_keys]
    if bound_vote_ids:
        open_votes = VoteSession.objects.filter(pk__in=bound_vote_ids, activity=activity).exclude(
            is_locked=True
        )
        if open_votes.exists():
            raise ValidationError("该赛段依赖的投票时段尚未锁定，请先锁定后再核定。")


_CONSUMED_BY_CONFIRMED_MSG = "该原始数据已被已核定赛段结果使用，请先由管理员解锁赛段结果。"


def _stage_consumed_facts(stage) -> dict[str, set]:
    """The raw pks a confirmed stage consumed, read back from its binding snapshot.

    This is the inverse of :func:`_ensure_stage_dependencies_final`: where that freeze
    gate requires the facts a stage *will* read to be at rest, this gate refuses to
    *un-wind* a round/vote/manual that a CONFIRMED stage already read. Both map the
    stage's closure keys (``round_keys``/``vote_keys``/``group_keys``/``manual_keys``)
    onto physical pks via the frozen version's binding.
    """
    version = stage.ruleset_version
    binding = _version_binding(version)
    checkpoint = stage.stage_key if _stage_is_checkpoint(version, stage.stage_key) else None
    round_keys, vote_keys, group_keys, manual_keys = stage_consumed_scopes(
        version.definition, checkpoint
    )
    round_map = binding.get("round_keys") or {}
    group_map = binding.get("group_keys") or {}
    vote_map = binding.get("vote_keys") or {}
    round_pks = {round_map.get(k) for k in round_keys} | {group_map.get(k) for k in group_keys}
    round_pks.discard(None)
    vote_pks = {vote_map.get(k) for k in vote_keys}
    vote_pks.discard(None)
    return {"rounds": round_pks, "votes": vote_pks, "manual": set(manual_keys)}


def ensure_round_not_consumed_by_confirmed_stage(contest_round) -> None:
    """Reject un-winding a round that a CONFIRMED stage of its activity already read."""
    consumed = StageResult.objects.filter(
        activity_id=contest_round.activity_id, status=StageResult.Status.CONFIRMED
    ).values("pk")
    for stage_pk in consumed:
        stage = StageResult.objects.get(pk=stage_pk["pk"])
        if contest_round.pk in _stage_consumed_facts(stage)["rounds"]:
            raise ValidationError(_CONSUMED_BY_CONFIRMED_MSG)


def ensure_vote_not_consumed_by_confirmed_stage(vote_session) -> None:
    """Reject un-winding a VoteSession that a CONFIRMED stage of its activity already read."""
    consumed = StageResult.objects.filter(
        activity_id=vote_session.activity_id, status=StageResult.Status.CONFIRMED
    ).values("pk")
    for stage_pk in consumed:
        stage = StageResult.objects.get(pk=stage_pk["pk"])
        if vote_session.pk in _stage_consumed_facts(stage)["votes"]:
            raise ValidationError(_CONSUMED_BY_CONFIRMED_MSG)


def ensure_manual_not_consumed_by_confirmed_stage(version, manual_key) -> None:
    """Reject mutating a manual pick that a CONFIRMED stage of the same version already read."""
    consumed = StageResult.objects.filter(
        ruleset_version_id=version.pk, status=StageResult.Status.CONFIRMED
    ).values("pk")
    for stage_pk in consumed:
        stage = StageResult.objects.get(pk=stage_pk["pk"])
        if manual_key in _stage_consumed_facts(stage)["manual"]:
            raise ValidationError(_CONSUMED_BY_CONFIRMED_MSG)


@transaction.atomic
def confirm_stage_result(stage: StageResult, *, confirmed_by):
    """核定并锁定 a resolved stage result into its final handcard state (§36-37).

    A resolver ``READY_TO_CONFIRM`` result is machine-computed but still mutable —
    another score edit would recompute it. The staff 核定 action is the point of no
    return: once CONFIRMED the result (and its decisions/composites) is immutable so
    a host can safely copy the handcard.

    M0 lock order and finality (M1-R6): lock the Activity first (the authoritative
    serialization point), then re-read the StageResult (never trust a pre-lock stale
    object), confirm it is the stage's *current* candidate, recompute the current input
    fingerprint and require it to match (no stale results frozen over changed facts), and
    require the consumed raw facts to be at rest (rounds/votes locked). Idempotent: a
    re-confirm of an already-locked row returns it as-is.
    """
    locked_activity = lock_activity_for_action(stage.activity, ActivityAction.PUBLISH_RESULT)
    locked = StageResult.objects.select_for_update().get(pk=stage.pk)
    if locked.activity_id != locked_activity.pk:
        raise ValidationError("赛段结果不属于当前活动。")
    if locked.status == StageResult.Status.CONFIRMED:
        return locked
    if locked.status != StageResult.Status.READY_TO_CONFIRM:
        raise ValidationError("仅可核定已解析到“待核定”状态的赛段结果。")
    latest = StageResult.objects.filter(
        activity=locked.activity, stage_key=locked.stage_key
    ).aggregate(m=Max("result_version"))["m"]
    if locked.result_version != latest:
        raise ValidationError("该赛段存在更新的结果版本，请核定最新结果。")
    try:
        current_fingerprint = _current_input_fingerprint(
            locked.ruleset_version, locked.activity, locked.stage_key
        )
    except ValueError as error:
        raise ValidationError(str(error))
    if current_fingerprint != locked.input_fingerprint:
        raise ValidationError("该结果已过期（原始分数/票数已变化），请重新计算后核定。")
    _ensure_stage_dependencies_final(locked.ruleset_version, locked.activity, locked.stage_key)
    locked.status = StageResult.Status.CONFIRMED
    locked.confirmed_by = confirmed_by
    locked.confirmed_at = timezone.now()
    locked.save(update_fields=["status", "confirmed_by", "confirmed_at"])
    AuditLog.objects.create(
        operator=confirmed_by,
        action_type=AuditLog.ActionType.CONFIRM_STAGE_RESULT,
        target=f"StageResult:{locked.pk}",
        old_value=StageResult.Status.READY_TO_CONFIRM,
        new_value=json.dumps(
            {
                "status": StageResult.Status.CONFIRMED,
                "stage_key": locked.stage_key,
                "result_version": locked.result_version,
                "ruleset_version": locked.ruleset_version_id,
                "authority_hash": locked.ruleset_version.authority_hash,
                "input_fingerprint": locked.input_fingerprint,
                "confirmed_by": confirmed_by.pk,
                "plan_version": locked.plan_version,
            },
            ensure_ascii=False,
            sort_keys=True,
        ),
    )
    return locked


@transaction.atomic
def unlock_stage_result(stage: StageResult, *, operator, note: str = "") -> StageResult:
    """Admin unlock a CONFIRMED stage result so its raw facts can be corrected (§38).

    Reverting to ``READY_TO_CONFIRM`` releases the finality that freezing the result
    imposed: the round / vote / manual edits that the result consumed are editable again,
    and the stage can be re-resolved and re-confirmed. Audits the change.
    """
    lock_activity_for_action(stage.activity)
    locked = StageResult.objects.select_for_update().get(pk=stage.pk)
    if locked.status != StageResult.Status.CONFIRMED:
        raise PermissionDenied("仅可解锁已核定并锁定的赛段结果。")
    locked.confirmed_by = None
    locked.confirmed_at = None
    locked.status = StageResult.Status.READY_TO_CONFIRM
    locked.save(update_fields=["confirmed_by", "confirmed_at", "status"], _bypass_confirmed=True)
    AuditLog.objects.create(
        operator=operator,
        action_type=AuditLog.ActionType.UNLOCK_STAGE_RESULT,
        target=f"StageResult:{locked.pk}",
        old_value=StageResult.Status.CONFIRMED,
        new_value=StageResult.Status.READY_TO_CONFIRM,
        note=note,
    )
    return locked


@transaction.atomic
def run_ruleset(
    version,
    activity,
    *,
    stage_key,
    computed_by,
    round_keys: Mapping[str, ContestRound],
    vote_scores=None,
    group_of=None,
    manual=None,
    checkpoint=None,
    preview: bool = False,
) -> StageResult:
    """Single generic entry: bind -> resolve -> persist. Returns the StageResult.

    ``checkpoint`` (§11-15) is an optional named boundary in the definition. When given,
    only the checkpoint's dependency closure is resolved (future-stage inputs no longer
    force a HOLD) and ``stage_key`` should be the checkpoint's key, so each stage persists
    as its own progressive :class:`StageResult`.

    ``preview`` (M1-R8) marks the call as a staff comparison, not a FORMAL publication: the
    formal path (default, used by :func:`recompute_activity_result`) only executes the
    *current* FROZEN authority, so a superseded frozen version can never produce a formal
    StageResult; a preview may run any frozen version side-by-side for staff to compare.
    """
    from ruleset.models import RulesetVersion

    if version.ruleset.activity_id != activity.pk:
        raise ValidationError("Ruleset version must belong to the result activity.")
    if version.status != RulesetVersion.Status.FROZEN:
        raise ValidationError("Only a frozen ruleset version may be executed.")
    if not version.is_current and not preview:
        raise ValidationError("Only the current frozen ruleset version produces a formal result.")
    inputs = bind_resolve_input(
        version,
        activity,
        round_keys=round_keys,
        vote_scores=vote_scores,
        group_of=group_of,
        manual=manual,
    )
    plan = _plan_from_version(version)
    if checkpoint:
        result = resolve_to_checkpoint(version.definition, inputs, checkpoint, plan=plan)
    else:
        result = resolve(version.definition, inputs, plan=plan)
    return persist_stage_result(
        version, activity, result, stage_key=stage_key, computed_by=computed_by
    )


def recompute_activity_result(
    activity,
    computed_by,
    *,
    ruleset=None,
    round_keys: Mapping[str, int] | None = None,
    checkpoint=None,
) -> StageResult:
    """Re-resolve an activity's current ruleset against its bound rounds (M1-H).

    The ruleset carries the production binding: ``stage_key`` and ``round_keys``
    (round key -> ContestRound pk). ``round_keys`` may be overridden (e.g. a test or
    a one-off re-resolve). ``checkpoint`` (§11-15) targets a single declared stage and
    publishes it as its own :class:`StageResult` (stage_key = the checkpoint key).
    Returns the persisted :class:`StageResult`.
    """
    from ruleset.models import ContestRuleset, RulesetVersion

    if ruleset is None:
        candidates = ContestRuleset.objects.filter(activity=activity, stage_key__gt="").order_by(
            "pk"
        )
        # §16/§32: one activity owns exactly one contest ruleset; versions hold the history.
        # A stray duplicate is a data error, so fail loudly instead of silently picking the
        # newest and revealing an ambiguous authority.
        if candidates.count() > 1:
            raise ValidationError("该活动存在多个自动重算赛制，请先清理重复。")
        ruleset = candidates.first()
    if ruleset is None:
        raise ValidationError("该活动尚未绑定可自动重算的赛制。")
    version = (
        ruleset.versions.filter(is_current=True, status=RulesetVersion.Status.FROZEN)
        .order_by("-version")
        .first()
    )
    if version is None:
        raise ValidationError("该赛制没有可用的当前冻结版本。")
    # The frozen version is authoritative: read its binding snapshot (never the still
    # mutable ContestRuleset rounding fields), except when round_keys is overridden.
    binding = _version_binding(version)
    raw_keys = round_keys if round_keys is not None else binding.get("round_keys") or {}
    round_ids = list(raw_keys.values())
    rounds = {r.pk: r for r in ContestRound.objects.filter(pk__in=round_ids, activity=activity)}
    missing = [rid for rid in round_ids if rid not in rounds]
    if missing:
        raise ValidationError(f"赛制绑定的比赛轮次不存在：{missing}")
    bound = {key: rounds[rid] for key, rid in raw_keys.items()}
    stage_key = checkpoint or binding.get("stage_key") or ruleset.stage_key or ""
    return run_ruleset(
        version,
        activity,
        stage_key=stage_key,
        computed_by=computed_by,
        round_keys=bound,
        vote_scores=_source_vote_scores(activity, binding),
        group_of=_source_group_of(activity, binding),
        manual=_source_manual(version, activity),
        checkpoint=checkpoint,
    )


_OUTCOME_LABELS = {
    "direct": "直接晋级",
    "advanced": "晋级",
    "repechage": "复活赛",
    "pending": "待定",
    "eliminated": "淘汰",
    "wildcard": "外卡",
    "finalist": "最终晋级",
}


def stage_decisions_by_blocks(stage_result: StageResult) -> list[dict]:
    """Group a stage result's decisions into handcard announcement blocks.

    Uses the ruleset's ``announcement_blocks`` config (list of ``{label,
    outcome_codes}``) when present; otherwise falls back to grouping by
    ``outcome_code``. Decisions are ordered by ``rank`` then pk within a block
    so a staff member can read the result card top-to-bottom.
    """
    decisions = list(stage_result.decisions.select_related("singer").order_by("rank", "pk"))
    version = stage_result.ruleset_version
    binding = _version_binding(version) if version else {}
    # A checkpoint stage prefers its own blocks; a global set is the legacy fallback.
    blocks_config = (binding.get("announcement_blocks") or []) if binding else []
    if binding and _stage_is_checkpoint(version, stage_result.stage_key):
        blocks_config = (binding.get("announcement_blocks_by_checkpoint") or {}).get(
            stage_result.stage_key
        ) or blocks_config
    by_code: dict[str, list[StageDecision]] = {}
    for decision in decisions:
        by_code.setdefault(decision.outcome_code, []).append(decision)

    if blocks_config:
        blocks = []
        consumed: set[int] = set()
        for block in blocks_config:
            label = block.get("label") or "公告"
            members = []
            for code in block.get("outcome_codes") or []:
                for decision in by_code.get(code, []):
                    if decision.pk not in consumed:
                        members.append(decision)
                        consumed.add(decision.pk)
            if members:
                blocks.append({"label": label, "decisions": members})
        leftover = [d for d in decisions if d.pk not in consumed]
        if leftover:
            blocks.append({"label": "其他", "decisions": leftover})
        return blocks

    ordered_codes: list[str] = []
    for decision in decisions:
        if decision.outcome_code not in ordered_codes:
            ordered_codes.append(decision.outcome_code)
    return [
        {"label": _OUTCOME_LABELS.get(code, code), "decisions": by_code[code]}
        for code in ordered_codes
    ]
