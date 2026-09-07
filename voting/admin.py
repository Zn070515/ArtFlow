from django.contrib import admin

from .models import VoteBallot, VoteOption, VoteRecord, VoteSession


class ObservationOnlyAdmin(admin.ModelAdmin):
    """Keep vote state and ballot facts visible but service-owned."""

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False


@admin.register(VoteSession)
class VoteSessionAdmin(ObservationOnlyAdmin):
    list_display = ["name", "activity", "purpose", "is_open", "is_locked", "created_at"]
    list_filter = ["purpose", "is_open", "is_locked", "activity"]
    search_fields = ["name", "activity__title"]


@admin.register(VoteOption)
class VoteOptionAdmin(ObservationOnlyAdmin):
    list_display = ["vote_session", "singer", "sort_order", "is_test_data"]
    list_filter = ["vote_session", "is_test_data"]
    search_fields = ["vote_session__name", "singer__name"]


@admin.register(VoteBallot)
class VoteBallotAdmin(ObservationOnlyAdmin):
    list_display = ["vote_session", "browser_session_key", "submitted_at", "is_test_data"]
    list_filter = ["vote_session", "is_test_data"]
    search_fields = ["browser_session_key"]


@admin.register(VoteRecord)
class VoteRecordAdmin(ObservationOnlyAdmin):
    list_display = ["vote_session", "vote_option", "ballot", "created_at", "is_test_data"]
    list_filter = ["vote_session", "is_test_data"]
    search_fields = ["browser_session_key", "vote_option__singer__name"]
