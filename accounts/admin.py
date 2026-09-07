from django.contrib import admin
from django.contrib.auth.admin import UserAdmin

from .models import User


@admin.register(User)
class CustomUserAdmin(UserAdmin):
    list_display = ["username", "email", "role", "is_active", "date_joined"]
    list_filter = ["role", "is_active"]
    fieldsets = tuple(UserAdmin.fieldsets or ()) + (("Role", {"fields": ("role",)}),)

    def get_readonly_fields(self, request, obj=None):
        if obj is None:
            return super().get_readonly_fields(request, obj)
        return (
            *super().get_readonly_fields(request, obj),
            "role",
            "is_active",
            "is_superuser",
            "is_staff",
        )
