from django.db import migrations, models

from core.models import generate_activity_public_code


class Migration(migrations.Migration):
    dependencies = [
        ("core", "0007_activity_judge_entry_open"),
    ]

    operations = [
        migrations.AlterField(
            model_name="activity",
            name="public_code",
            field=models.CharField(
                default=generate_activity_public_code,
                editable=False,
                max_length=8,
                unique=True,
            ),
        ),
    ]
