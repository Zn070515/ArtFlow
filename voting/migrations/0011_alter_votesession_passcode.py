from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("voting", "0010_one_open_session_per_activity")]

    operations = [
        migrations.AlterField(
            model_name="votesession",
            name="passcode",
            field=models.CharField(blank=True, default="", max_length=20),
        ),
    ]
