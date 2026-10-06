from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("singer_contest", "0045_groupstage_roster_source_and_more")]

    operations = [
        migrations.AddField(
            model_name="groupstage",
            name="source_roster_fingerprint",
            field=models.CharField(
                blank=True,
                default="",
                help_text="ROUND_ADVANCED 来源在确认时的晋级名单指纹。",
                max_length=64,
            ),
        ),
    ]
