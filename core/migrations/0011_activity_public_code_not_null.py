from django.db import migrations, models

import core.models
import secrets


_PUBLIC_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


def _generate_public_code() -> str:
    return "".join(secrets.choice(_PUBLIC_CODE_ALPHABET) for _ in range(8))


def backfill_public_codes(apps, schema_editor):
    Activity = apps.get_model("core", "Activity")
    using = schema_editor.connection.alias
    used = set(
        Activity.objects.using(using)
        .exclude(public_code__isnull=True)
        .exclude(public_code="")
        .values_list("public_code", flat=True)
    )
    for activity in Activity.objects.using(using).filter(public_code__isnull=True).iterator():
        code = _generate_public_code()
        while code in used:
            code = _generate_public_code()
        used.add(code)
        Activity.objects.using(using).filter(pk=activity.pk).update(public_code=code)


class Migration(migrations.Migration):
    dependencies = [("core", "0010_alter_activity_public_code")]

    operations = [
        migrations.RunPython(backfill_public_codes, migrations.RunPython.noop),
        migrations.AlterField(
            model_name="activity",
            name="public_code",
            field=models.CharField(
                default=core.models.generate_activity_public_code,
                editable=False,
                max_length=8,
                unique=True,
            ),
        ),
    ]
