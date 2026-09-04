from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("singer_contest", "0027_stageawarddecision_and_award_authority")]

    operations = [
        migrations.AddField(
            model_name="contestround",
            name="tie_order_policy",
            field=models.CharField(
                choices=[
                    ("review", "同分待人工决定"),
                    ("registration_order", "同分按报名序"),
                    ("draw", "同分抽签"),
                ],
                default="review",
                help_text="上一轮成绩同分时的显式处理规则。",
                max_length=24,
            ),
        )
    ]
