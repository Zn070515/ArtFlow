from django.db import migrations, models


def backfill_public_codes(apps, schema_editor):
    Ticket = apps.get_model("tickets", "Ticket")
    for ticket in Ticket.objects.order_by("pk").iterator():
        ticket.public_code = f"LEGACY{ticket.pk:X}"[-12:]
        ticket.save(update_fields=["public_code"])


class Migration(migrations.Migration):
    dependencies = [("tickets", "0001_initial")]

    operations = [
        migrations.AddField(
            model_name="ticket",
            name="credential_version",
            field=models.PositiveIntegerField(default=1, editable=False),
        ),
        migrations.AddField(
            model_name="ticket",
            name="public_code",
            field=models.CharField(blank=True, editable=False, max_length=12, null=True, unique=True),
        ),
        migrations.RunPython(backfill_public_codes, migrations.RunPython.noop),
    ]
