from django.contrib import admin

from .models import (
    Award,
    ContestRound,
    Judge,
    RoundEntry,
    RoundJudge,
    ScoreRecord,
    ScoreSummary,
    SingerRegistration,
)


@admin.register(SingerRegistration)
class SingerRegistrationAdmin(admin.ModelAdmin):
    list_display = ["name", "song_name", "activity", "pre_status", "live_status", "created_at"]
    list_filter = ["pre_status", "live_status", "activity"]
    search_fields = ["name", "student_id", "song_name"]


@admin.register(ContestRound)
class ContestRoundAdmin(admin.ModelAdmin):
    list_display = ["name", "activity", "round_type", "scoring_mode", "status", "is_locked"]


@admin.register(Judge)
class JudgeAdmin(admin.ModelAdmin):
    list_display = ["name", "activity", "is_active"]


@admin.register(RoundEntry)
class RoundEntryAdmin(admin.ModelAdmin):
    list_display = ["round", "singer"]


@admin.register(RoundJudge)
class RoundJudgeAdmin(admin.ModelAdmin):
    list_display = ["round", "judge"]


@admin.register(ScoreRecord)
class ScoreRecordAdmin(admin.ModelAdmin):
    list_display = ["round", "singer", "judge", "score"]


@admin.register(ScoreSummary)
class ScoreSummaryAdmin(admin.ModelAdmin):
    list_display = ["round", "singer", "average_score", "rank", "is_advanced"]


@admin.register(Award)
class AwardAdmin(admin.ModelAdmin):
    list_display = ["name", "singer", "activity"]
