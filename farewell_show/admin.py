from django.contrib import admin

from .models import Program


@admin.register(Program)
class ProgramAdmin(admin.ModelAdmin):
    list_display = ["name", "program_type", "contact_name", "activity", "status", "sort_order"]
    list_filter = ["status", "program_type", "activity"]
    search_fields = ["name", "contact_name"]
