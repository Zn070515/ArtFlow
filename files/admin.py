from django.contrib import admin

from .models import MaterialCheck, StaffNote, SubmissionFile


@admin.register(SubmissionFile)
class SubmissionFileAdmin(admin.ModelAdmin):
    list_display = ["original_name", "file_purpose", "uploaded_by", "uploaded_at"]
    list_filter = ["file_purpose"]


@admin.register(StaffNote)
class StaffNoteAdmin(admin.ModelAdmin):
    list_display = ["content_preview", "created_by", "created_at"]

    def content_preview(self, obj):
        return obj.content[:60]


@admin.register(MaterialCheck)
class MaterialCheckAdmin(admin.ModelAdmin):
    list_display = ["item_name", "status", "singer_registration", "program"]
