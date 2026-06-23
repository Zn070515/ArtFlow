from django.contrib import admin

from .models import PublicMedia, PublicPost


class PublicMediaInline(admin.TabularInline):
    model = PublicMedia
    extra = 0
    fields = ["image", "caption", "is_published", "sort_order"]


@admin.register(PublicPost)
class PublicPostAdmin(admin.ModelAdmin):
    list_display = ["title", "post_type", "status", "is_pinned", "published_at", "created_at"]
    list_filter = ["post_type", "status"]
    search_fields = ["title"]
    inlines = [PublicMediaInline]


@admin.register(PublicMedia)
class PublicMediaAdmin(admin.ModelAdmin):
    list_display = ["caption", "post", "is_published", "sort_order", "created_at"]
    list_filter = ["is_published", "post__post_type"]
    search_fields = ["caption", "original_name", "post__title"]
