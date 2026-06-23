from django.contrib import admin

from .models import PublicPost


@admin.register(PublicPost)
class PublicPostAdmin(admin.ModelAdmin):
    list_display = ["title", "post_type", "status", "is_pinned", "published_at", "created_at"]
    list_filter = ["post_type", "status"]
    search_fields = ["title"]
