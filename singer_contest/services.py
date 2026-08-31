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
from django.db.models import QuerySet
from ruleset.compiler import ExecutionPlan, compile_version
from ruleset.resolver import ResolveInput, resolve

from .models import (
    CompositeResult,
    ContestRound,
    Judge,
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


def _read_artflow_meta(workbook) -> dict[str, str]:
    if _META_SHEET_NAME not in workbook.sheetnames:
        return {}
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


def bound_ruleset_version_label(contest_round: ContestRound) -> str:
    """Label the frozen ruleset version bound to a round via round_keys, if any."""
    from ruleset.models import ContestRuleset, RulesetVersion

    for ruleset in ContestRuleset.objects.filter(activity_id=contest_round.activity_id):
        for round_key, round_pk in (ruleset.round_keys or {}).items():
            if str(round_pk) != str(contest_round.pk):
                continue
            version = RulesetVersion.objects.filter(
                ruleset=ruleset,
                is_current=True,
                status=RulesetVersion.Status.FROZEN,
            ).first()
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
    if meta.get("round_id"):
        return _parse_id_authority_workbook(rows, headers, meta, contest_round)
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


def _plan_from_version(version) -> ExecutionPlan:
    if version.execution_plan:
        return ExecutionPlan.from_dict(json.loads(version.execution_plan))
    report, plan = compile_version(version)
    if not report.passes():
        raise ValidationError("无法解析无效赛制版本。")
    return plan


@transaction.atomic
def persist_stage_result(version, activity, result, *, stage_key, computed_by):
    """Write a :class:`ResolveResult` into StageResult + decisions + composites."""
    if version.ruleset.activity_id != activity.pk:
        raise ValidationError("Ruleset version must belong to the result activity.")
    is_test = runtime_is_test(activity)
    singer_by_key = {str(s.pk): s for s in SingerRegistration.objects.filter(activity=activity)}
    missing = [d.contestant for d in result.decisions if d.contestant not in singer_by_key]
    if missing:
        raise ValidationError(f"无法将结果写回选手：{missing}")

    stage = StageResult.objects.create(
        activity=activity,
        ruleset_version=version,
        created_by=computed_by,
        stage_key=stage_key,
        status=result.status.value,
        reasons=list(result.reasons),
        content_hash=result.content_hash,
        schema_version=result.schema_version,
        plan_version=result.plan_version,
        result_version=result.result_version,
        is_test_data=is_test,
    )
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
    return stage


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
) -> StageResult:
    """Single generic entry: bind -> resolve -> persist. Returns the StageResult."""
    from ruleset.models import RulesetVersion

    if version.ruleset.activity_id != activity.pk:
        raise ValidationError("Ruleset version must belong to the result activity.")
    if version.status != RulesetVersion.Status.FROZEN:
        raise ValidationError("Only a frozen ruleset version may be executed.")
    inputs = bind_resolve_input(
        version,
        activity,
        round_keys=round_keys,
        vote_scores=vote_scores,
        group_of=group_of,
        manual=manual,
    )
    result = resolve(version.definition, inputs, plan=_plan_from_version(version))
    return persist_stage_result(
        version, activity, result, stage_key=stage_key, computed_by=computed_by
    )


def recompute_activity_result(
    activity,
    computed_by,
    *,
    ruleset=None,
    round_keys: Mapping[str, int] | None = None,
) -> StageResult:
    """Re-resolve an activity's current ruleset against its bound rounds (M1-H).

    The ruleset carries the production binding: ``stage_key`` and ``round_keys``
    (round key -> ContestRound pk). ``round_keys`` may be overridden (e.g. a test or
    a one-off re-resolve). Returns the persisted :class:`StageResult`.
    """
    from ruleset.models import ContestRuleset, RulesetVersion

    ruleset = ruleset or (
        ContestRuleset.objects.filter(activity=activity, stage_key__gt="").order_by("-pk").first()
    )
    if ruleset is None:
        raise ValidationError("该活动尚未绑定可自动重算的赛制。")
    raw_keys = round_keys or ruleset.round_keys or {}
    round_ids = list(raw_keys.values())
    rounds = {r.pk: r for r in ContestRound.objects.filter(pk__in=round_ids, activity=activity)}
    missing = [rid for rid in round_ids if rid not in rounds]
    if missing:
        raise ValidationError(f"赛制绑定的比赛轮次不存在：{missing}")
    version = (
        ruleset.versions.filter(is_current=True, status=RulesetVersion.Status.FROZEN)
        .order_by("-version")
        .first()
    )
    if version is None:
        raise ValidationError("该赛制没有可用的当前冻结版本。")
    bound = {key: rounds[rid] for key, rid in raw_keys.items()}
    return run_ruleset(
        version,
        activity,
        stage_key=ruleset.stage_key,
        computed_by=computed_by,
        round_keys=bound,
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
    ruleset = stage_result.ruleset_version.ruleset
    blocks_config = (ruleset.announcement_blocks or []) if ruleset else []
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
