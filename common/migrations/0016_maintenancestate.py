from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("common", "0015_alter_auditlog_action_type")]

    operations = [
        migrations.CreateModel(
            name="MaintenanceState",
            fields=[
                (
                    "id",
                    models.PositiveSmallIntegerField(
                        default=1, editable=False, primary_key=True, serialize=False
                    ),
                ),
                ("enabled", models.BooleanField(default=False)),
                ("reason", models.CharField(blank=True, max_length=120)),
                ("started_at", models.DateTimeField(blank=True, null=True)),
            ],
            options={
                "verbose_name": "maintenance state",
                "verbose_name_plural": "maintenance state",
            },
        )
    ]
