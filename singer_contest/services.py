from __future__ import annotations

import json
from decimal import Decimal, InvalidOperation
from typing import Iterable

from common.models import AuditLog
from django.core.exceptions import ValidationError
from django.db import transaction
from django.db.models import QuerySet

from .models import (
    ContestRound,
    Judge,
    RoundEntry,
    RoundJudge,
    ScoreRecord,
    ScoreSummary,
    SingerRegistration,
)


def _eligible_singers(contest_round: ContestRound) -> QuerySet[SingerRegistration]:
    return SingerRegistration.objects.filter(round_entries__round=contest_round).order_by("pk")


def _active_judges(contest_round: ContestRound) -> QuerySet[Judge]:
    return Judge.objects.filter(round_assignments__round=contest_round).order_by("pk")


@transaction.atomic
def prepare_round(contest_round: ContestRound, operator) -> ContestRound:
    locked_round = (
        ContestRound.objects.select_for_update().select_related("activity").get(pk=contest_round.pk)
    )
    if locked_round.status != ContestRound.Status.DRAFT:
        raise ValidationError("比赛轮次只能从草稿状态准备。")

    if locked_round.round_type == ContestRound.RoundType.PRELIMINARY:
        singers = list(
            SingerRegistration.objects.filter(
                activity=locked_round.activity,
                pre_status=SingerRegistration.PreStatus.APPROVED,
                is_test_data=False,
            ).order_by("pk")
        )
    else:
        previous_round = ContestRound.objects.filter(
            activity=locked_round.activity,
            round_type=ContestRound.RoundType.PRELIMINARY,
        ).first()
        if previous_round is None:
            raise ValidationError("后续轮次必须先有上一轮比赛。")
        singers = list(
            SingerRegistration.objects.filter(
                activity=locked_round.activity,
                summaries__round=previous_round,
                summaries__is_advanced=True,
            ).order_by("pk")
        )

    judges = list(
        Judge.objects.filter(activity=locked_round.activity, is_active=True).order_by("pk")
    )
    if not singers or not judges:
        raise ValidationError("准备比赛轮次需要至少一名选手和一名活跃评委。")

    RoundEntry.objects.bulk_create([RoundEntry(round=locked_round, singer=singer) for singer in singers])
    RoundJudge.objects.bulk_create([RoundJudge(round=locked_round, judge=judge) for judge in judges])
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
    summaries = ScoreSummary.objects.filter(round=contest_round).order_by(
        "-average_score", "singer_id"
    )
    for rank, summary in enumerate(summaries, start=1):
        summary.rank = rank
        summary.is_advanced = bool(
            contest_round.advance_count and rank <= contest_round.advance_count
        )
        summary.save(update_fields=["rank", "is_advanced"])


@transaction.atomic
def apply_scores(
    contest_round: ContestRound,
    score_values: dict[tuple[int, int], object],
    operator,
    *,
    note: str = "",
) -> list[dict[str, int | str | None]]:
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
        if old_score == score:
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
    if locked_round.status == ContestRound.Status.PREPARED:
        locked_round.status = ContestRound.Status.SCORING
        locked_round.save(update_fields=["status"])
    if changes:
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
