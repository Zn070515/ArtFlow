import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("singer_contest", "0026_dueldecision"),
    ]

    operations = [
        migrations.CreateModel(
            name="StageAwardDecision",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("name", models.CharField(max_length=100)),
                ("source_node", models.CharField(blank=True, max_length=100)),
                ("is_test_data", models.BooleanField(default=False)),
                (
                    "activity",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="stage_award_decisions",
                        to="core.activity",
                    ),
                ),
                (
                    "singer",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="stage_award_decisions",
                        to="singer_contest.singerregistration",
                    ),
                ),
                (
                    "stage_result",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="award_decisions",
                        to="singer_contest.stageresult",
                    ),
                ),
            ],
            options={
                "ordering": ["stage_result", "name", "pk"],
            },
        ),
        migrations.AddField(
            model_name="award",
            name="source_award_decision",
            field=models.OneToOneField(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="official_award",
                to="singer_contest.stageawarddecision",
            ),
        ),
        migrations.AddConstraint(
            model_name="stageawarddecision",
            constraint=models.UniqueConstraint(
                fields=("stage_result", "singer", "name"),
                name="stage_award_decision_unique_candidate",
            ),
        ),
    ]
