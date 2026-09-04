import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("singer_contest", "0023_roundentry_running_order_and_order_policy"),
    ]

    operations = [
        migrations.AddField(
            model_name="award",
            name="source_node",
            field=models.CharField(blank=True, max_length=100),
        ),
        migrations.AddField(
            model_name="award",
            name="source_stage_result",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="awards",
                to="singer_contest.stageresult",
            ),
        ),
    ]
