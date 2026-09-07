from django.contrib import admin

from .models import AccessGrant, EntryPoint, EphemeralSession


class ReadOnlyLifecycleAdmin(admin.ModelAdmin):
    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False


@admin.register(EntryPoint)
class EntryPointAdmin(ReadOnlyLifecycleAdmin):
    list_display = ("id", "activity", "kind", "label", "is_active", "created_at")
    list_filter = ("kind", "is_active")
    search_fields = ("label", "activity__title")
    readonly_fields = (
        "activity",
        "kind",
        "label",
        "is_active",
        "created_by",
        "created_at",
        "updated_at",
    )


@admin.register(AccessGrant)
class AccessGrantAdmin(ReadOnlyLifecycleAdmin):
    exclude = ("token_digest",)
    list_display = (
        "id",
        "entry_point",
        "kind",
        "activity",
        "round",
        "expires_at",
        "redeemed_at",
        "revoked_at",
    )
    list_filter = ("kind", "redeemed_at", "revoked_at")
    search_fields = ("entry_point__label", "activity__title")
    readonly_fields = (
        "entry_point",
        "kind",
        "activity",
        "round",
        "expires_at",
        "redeemed_at",
        "revoked_at",
        "issued_by",
        "created_at",
    )


@admin.register(EphemeralSession)
class EphemeralSessionAdmin(ReadOnlyLifecycleAdmin):
    exclude = ("token_digest",)
    list_display = (
        "id",
        "grant",
        "kind",
        "activity",
        "round",
        "expires_at",
        "last_seen_at",
        "revoked_at",
    )
    list_filter = ("kind", "revoked_at")
    search_fields = ("activity__title", "grant__entry_point__label")
    readonly_fields = (
        "grant",
        "kind",
        "activity",
        "round",
        "expires_at",
        "last_seen_at",
        "revoked_at",
        "created_at",
    )
