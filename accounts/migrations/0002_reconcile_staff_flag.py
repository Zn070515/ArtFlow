from django.db import migrations


def clear_stale_staff_flags(apps, schema_editor):
    User = apps.get_model("accounts", "User")
    User.objects.filter(is_superuser=False, is_staff=True).exclude(
        role__in=["staff", "admin"]
    ).update(is_staff=False)


class Migration(migrations.Migration):
    dependencies = [("accounts", "0001_initial")]

    operations = [migrations.RunPython(clear_stale_staff_flags, migrations.RunPython.noop)]
