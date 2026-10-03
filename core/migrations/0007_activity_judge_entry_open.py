from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("core", "0006_activity_public_code"),
    ]

    operations = [
        migrations.AddField(
            model_name="activity",
            name="judge_entry_open",
            field=models.BooleanField(
                default=False,
                help_text="TEST 活动的评委彩排入口是否暂时开放。",
            ),
        ),
    ]
