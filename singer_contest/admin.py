from django.contrib import admin
from django.db import transaction
from django.db.models import Count

from .models import (
    Award,
    ContestRound,
    CriterionScore,
    Judge,
    RoundEntry,
    RoundJudge,
    RubricCriterion,
    ScoreRecord,
    ScoreSummary,
    ScoringRubric,
    SingerRegistration,
)


@admin.register(SingerRegistration)
class SingerRegistrationAdmin(admin.ModelAdmin):
    list_display = ["name", "song_name", "activity", "pre_status", "live_status", "created_at"]
    list_filter = ["pre_status", "live_status", "activity"]
    search_fields = ["name", "student_id", "song_name"]


@admin.register(ContestRound)
class ContestRoundAdmin(admin.ModelAdmin):
    readonly_fields = ["status", "is_locked"]
    list_display = [
        "name",
        "activity",
        "round_type",
        "scoring_mode",
        "order_policy",
        "status",
        "is_locked",
        "entry_count",
        "judge_count",
    ]

    def get_queryset(self, request):
        return (
            super()
            .get_queryset(request)
            .annotate(
                entry_count_value=Count("entries", distinct=True),
                judge_count_value=Count("round_judges", distinct=True),
            )
        )

    @admin.display(description="选手快照数", ordering="entry_count_value")
    def entry_count(self, contest_round):
        return getattr(contest_round, "entry_count_value", contest_round.entries.count())

    @admin.display(description="评委快照数", ordering="judge_count_value")
    def judge_count(self, contest_round):
        return getattr(contest_round, "judge_count_value", contest_round.round_judges.count())


@admin.register(Judge)
class JudgeAdmin(admin.ModelAdmin):
    list_display = ["name", "activity", "is_active"]


class RoundSnapshotAdmin(admin.ModelAdmin):
    def delete_queryset(self, request, queryset):
        with transaction.atomic():
            for snapshot in queryset:
                snapshot.delete()


@admin.register(RoundEntry)
class RoundEntryAdmin(RoundSnapshotAdmin):
    list_display = ["round", "singer", "running_order"]


@admin.register(RoundJudge)
class RoundJudgeAdmin(RoundSnapshotAdmin):
    list_display = ["round", "judge"]


@admin.register(ScoreRecord)
class ScoreRecordAdmin(admin.ModelAdmin):
    list_display = ["round", "singer", "judge", "score"]
    readonly_fields = ["round", "singer", "judge", "score", "notes", "is_test_data"]

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False


@admin.register(CriterionScore)
class CriterionScoreAdmin(admin.ModelAdmin):
    list_display = ["score_record", "criterion", "value"]
    readonly_fields = ["score_record", "criterion", "value", "is_test_data"]

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False


class RubricCriterionInline(admin.TabularInline):
    model = RubricCriterion
    extra = 1


@admin.register(ScoringRubric)
class ScoringRubricAdmin(admin.ModelAdmin):
    list_display = ["name", "activity", "sequence"]
    inlines = [RubricCriterionInline]


@admin.register(RubricCriterion)
class RubricCriterionAdmin(admin.ModelAdmin):
    list_display = ["name", "rubric", "max_score", "sequence"]


@admin.register(ScoreSummary)
class ScoreSummaryAdmin(admin.ModelAdmin):
    list_display = ["round", "singer", "average_score", "rank", "is_advanced"]


@admin.register(Award)
class AwardAdmin(admin.ModelAdmin):
    list_display = ["name", "singer", "activity"]
