from django.db import migrations, models
from django.db.models import Q


class Migration(migrations.Migration):
    dependencies = [
        ("singer_contest", "0022_audiencescore"),
    ]

    operations = [
        migrations.AddField(
            model_name="contestround",
            name="order_policy",
            field=models.CharField(
                choices=[
                    ("registration_order", "报名顺序"),
                    ("draw", "抽签顺序"),
                    ("manual", "人工顺序"),
                    ("previous_rank_asc", "上一轮排名升序"),
                    ("previous_rank_desc", "上一轮排名降序"),
                ],
                default="registration_order",
                help_text="准备轮次时冻结的出场顺序规则。",
                max_length=24,
            ),
        ),
        migrations.AddField(
            model_name="roundentry",
            name="running_order",
            field=models.PositiveIntegerField(
                blank=True, help_text="准备轮次时冻结的现场出场序号。", null=True
            ),
        ),
        migrations.AddConstraint(
            model_name="roundentry",
            constraint=models.UniqueConstraint(
                condition=Q(running_order__isnull=False),
                fields=("round", "running_order"),
                name="round_entry_unique_running_order",
            ),
        ),
    ]
