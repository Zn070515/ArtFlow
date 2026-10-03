import secrets

from django.db import migrations, models

from core.models import generate_activity_public_code

_PUBLIC_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


def _generate_public_code() -> str:
    return "".join(secrets.choice(_PUBLIC_CODE_ALPHABET) for _ in range(8))


def backfill_public_codes(apps, schema_editor):
    Activity = apps.get_model("core", "Activity")
    using = schema_editor.connection.alias
    used: set[str] = set(
        Activity.objects.using(using).exclude(public_code__isnull=True).values_list(
            "public_code", flat=True
        )
    )
    for activity in Activity.objects.using(using).filter(public_code__isnull=True).iterator():
        code = _generate_public_code()
        while code in used:
            code = _generate_public_code()
        used.add(code)
        Activity.objects.using(using).filter(pk=activity.pk).update(public_code=code)


class Migration(migrations.Migration):
    dependencies = [
        ("core", "0005_retire_unused_phase_and_qr_models"),
    ]

    operations = [
        migrations.AddField(
            model_name="activity",
            name="public_code",
            field=models.CharField(
                blank=True,
                editable=False,
                max_length=8,
                null=True,
                unique=True,
            ),
        ),
        migrations.RunPython(backfill_public_codes, migrations.RunPython.noop),
        migrations.AlterField(
            model_name="activity",
            name="public_code",
            field=models.CharField(
                blank=True,
                default=generate_activity_public_code,
                editable=False,
                max_length=8,
                null=True,
                unique=True,
            ),
        ),
    ]
