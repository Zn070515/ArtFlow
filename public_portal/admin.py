from django.contrib import admin

from .forms import PublicMediaForm, PublicPostAdminForm
from .models import PublicMedia, PublicPost, ResultRelease


def _post_is_released(post) -> bool:
    return bool(
        post is not None
        and post.pk
        and post.result_releases.filter(status=ResultRelease.Status.ACTIVE).exists()
    )


class PublicMediaInline(admin.TabularInline):
    model = PublicMedia
    form = PublicMediaForm
    extra = 0
    fields = ["image", "caption", "is_published", "sort_order"]

    def has_add_permission(self, request, obj=None):
        return not _post_is_released(obj) and super().has_add_permission(request, obj)

    def has_change_permission(self, request, obj=None):
        return not _post_is_released(obj) and super().has_change_permission(request, obj)

    def has_delete_permission(self, request, obj=None):
        return not _post_is_released(obj) and super().has_delete_permission(request, obj)


@admin.register(PublicPost)
class PublicPostAdmin(admin.ModelAdmin):
    form = PublicPostAdminForm
    list_display = ["title", "post_type", "status", "is_pinned", "published_at", "created_at"]
    list_filter = ["post_type", "status"]
    search_fields = ["title"]
    inlines = [PublicMediaInline]

    def get_readonly_fields(self, request, obj=None):
        if obj is not None and _post_is_released(obj):
            return [field.name for field in obj._meta.fields]
        return super().get_readonly_fields(request, obj)

    def has_delete_permission(self, request, obj=None):
        return not _post_is_released(obj) and super().has_delete_permission(request, obj)


@admin.register(PublicMedia)
class PublicMediaAdmin(admin.ModelAdmin):
    form = PublicMediaForm
    list_display = ["caption", "post", "is_published", "sort_order", "created_at"]
    list_filter = ["is_published", "post__post_type"]
    search_fields = ["caption", "original_name", "post__title"]

    @staticmethod
    def _media_is_released(obj) -> bool:
        return bool(
            obj is not None
            and obj.pk
            and obj.post_id
            and ResultRelease.objects.filter(
                post_id=obj.post_id, status=ResultRelease.Status.ACTIVE
            ).exists()
        )

    def has_change_permission(self, request, obj=None):
        return not self._media_is_released(obj) and super().has_change_permission(request, obj)

    def has_delete_permission(self, request, obj=None):
        return not self._media_is_released(obj) and super().has_delete_permission(request, obj)
