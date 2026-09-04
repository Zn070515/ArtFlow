from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("voting", "0005_votesession_vote_locked_must_be_closed_and_more")]

    operations = [
        migrations.AddField(
            model_name="votesession",
            name="purpose",
            field=models.CharField(
                choices=[
                    ("selection", "晋级/选择"),
                    ("popularity", "人气奖"),
                    ("repechage", "复活"),
                ],
                default="selection",
                max_length=16,
            ),
        )
    ]
