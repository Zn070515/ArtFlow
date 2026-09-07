from django.contrib import admin

from .models import MaterialCheck, MaterialRequirement, StaffNote, SubmissionFile


class ObservationOnlyAdmin(admin.ModelAdmin):
    """Keep service-owned file/review facts inspectable but immutable in Admin."""

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False


@admin.register(SubmissionFile)
class SubmissionFileAdmin(ObservationOnlyAdmin):
    list_display = [
        "original_name",
        "file_purpose",
        "version",
        "is_current",
        "uploaded_by",
        "uploaded_at",
    ]
    list_filter = ["file_purpose", "is_current", "is_test_data"]


@admin.register(StaffNote)
class StaffNoteAdmin(admin.ModelAdmin):
    list_display = ["content_preview", "created_by", "created_at"]

    def content_preview(self, obj):
        return obj.content[:60]


@admin.register(MaterialCheck)
class MaterialCheckAdmin(ObservationOnlyAdmin):
    list_display = [
        "item_name",
        "status",
        "singer_registration",
        "program",
        "reviewed_by",
        "reviewed_at",
    ]
    list_filter = ["status"]


@admin.register(MaterialRequirement)
class MaterialRequirementAdmin(admin.ModelAdmin):
    list_display = [
        "item_name",
        "activity",
        "applies_to",
        "file_purpose",
        "is_required",
        "sort_order",
    ]
    list_filter = ["activity", "applies_to", "is_required"]
