from django.contrib import admin
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


class ObservationOnlyAdmin(admin.ModelAdmin):
    """Expose authoritative facts without creating a second write path."""

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False


@admin.register(SingerRegistration)
class SingerRegistrationAdmin(admin.ModelAdmin):
    list_display = ["name", "song_name", "activity", "pre_status", "live_status", "created_at"]
    list_filter = ["pre_status", "live_status", "activity"]
    search_fields = ["name", "student_id", "song_name"]

    def get_readonly_fields(self, request, obj=None):
        if obj is None:
            return super().get_readonly_fields(request, obj)
        return (*super().get_readonly_fields(request, obj), "activity", "user")


@admin.register(ContestRound)
class ContestRoundAdmin(ObservationOnlyAdmin):
    readonly_fields = [
        "activity",
        "round_type",
        "scoring_mode",
        "minimum_judge_count",
        "name",
        "sequence",
        "order_policy",
        "tie_order_policy",
        "scheduled_at",
        "venue",
        "rubric",
        "advance_count",
        "roster_source",
        "roster_source_stage",
        "status",
        "is_locked",
        "score_version",
        "advancement_status",
    ]
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

    def get_readonly_fields(self, request, obj=None):
        if obj is None:
            return super().get_readonly_fields(request, obj)
        return (*super().get_readonly_fields(request, obj), "activity")


class RoundSnapshotAdmin(ObservationOnlyAdmin):
    pass


@admin.register(RoundEntry)
class RoundEntryAdmin(RoundSnapshotAdmin):
    list_display = ["round", "singer", "running_order"]


@admin.register(RoundJudge)
class RoundJudgeAdmin(RoundSnapshotAdmin):
    list_display = ["round", "judge"]


@admin.register(ScoreRecord)
class ScoreRecordAdmin(ObservationOnlyAdmin):
    list_display = ["round", "singer", "judge", "score"]
    readonly_fields = ["round", "singer", "judge", "score", "notes", "is_test_data"]


@admin.register(CriterionScore)
class CriterionScoreAdmin(ObservationOnlyAdmin):
    list_display = ["score_record", "criterion", "value"]
    readonly_fields = ["score_record", "criterion", "value", "is_test_data"]


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
class ScoreSummaryAdmin(ObservationOnlyAdmin):
    list_display = ["round", "singer", "average_score", "rank", "is_advanced"]
    readonly_fields = [
        "round",
        "singer",
        "average_score",
        "rank",
        "is_advanced",
        "is_test_data",
    ]


@admin.register(Award)
class AwardAdmin(ObservationOnlyAdmin):
    list_display = ["name", "singer", "activity"]
    readonly_fields = [
        "source_vote_session",
        "source_stage_result",
        "source_award_decision",
        "source_node",
    ]
