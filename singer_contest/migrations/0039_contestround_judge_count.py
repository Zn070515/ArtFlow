from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("singer_contest", "0038_judgeseat_display_label_judgesession_active_unique"),
    ]

    operations = [
        migrations.AddField(
            model_name="contestround",
            name="judge_count",
            field=models.PositiveIntegerField(
                blank=True,
                help_text="匿名评委通道数量；留空时沿用历史评委名单。",
                null=True,
            ),
        ),
        migrations.AddConstraint(
            model_name="contestround",
            constraint=models.CheckConstraint(
                condition=models.Q(judge_count__isnull=True)
                | models.Q(judge_count__gte=1),
                name="round_judge_count_positive",
            ),
        ),
    ]
