import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("singer_contest", "0025_alter_roundentry_options"),
        ("core", "0004_alter_activity_options"),
        ("ruleset", "0013_rulesettemplate_is_available"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name="DuelDecision",
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
                ("duel_key", models.CharField(max_length=100)),
                (
                    "pair_key",
                    models.CharField(
                        help_text="两个选手 PK 按当前赛制名单顺序拼接，例如 12|34。",
                        max_length=201,
                    ),
                ),
                ("winner", models.CharField(max_length=100)),
                ("is_test_data", models.BooleanField(default=False)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                (
                    "activity",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="duel_decisions",
                        to="core.activity",
                    ),
                ),
                (
                    "created_by",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="duel_decisions",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
                (
                    "ruleset_version",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="duel_decisions",
                        to="ruleset.rulesetversion",
                    ),
                ),
            ],
            options={
                "ordering": ["duel_key", "pair_key", "pk"],
                "unique_together": {("ruleset_version", "duel_key", "pair_key")},
            },
        ),
    ]
