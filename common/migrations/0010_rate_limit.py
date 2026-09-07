from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("common", "0009_alter_auditlog_action_type"),
    ]

    operations = [
        migrations.CreateModel(
            name="RateLimitBucket",
            fields=[
                (
                    "id",
                    models.BigAutoField(
                        auto_created=True,
                        primary_key=True,
                        serialize=False,
                        verbose_name="ID",
                    ),
                ),
                ("key", models.CharField(max_length=64, unique=True)),
                ("window_started_at", models.DateTimeField()),
                ("count", models.PositiveIntegerField()),
                ("expires_at", models.DateTimeField()),
            ],
            options={
                "indexes": [
                    models.Index(
                        fields=["expires_at"],
                        name="common_rate_limit_expiry_idx",
                    )
                ],
            },
        ),
    ]
