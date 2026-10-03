from django.db import migrations, models

import core.models


class Migration(migrations.Migration):
    dependencies = [("core", "0010_alter_activity_public_code")]

    operations = [
        migrations.AlterField(
            model_name="activity",
            name="public_code",
            field=models.CharField(
                default=core.models.generate_activity_public_code,
                editable=False,
                max_length=8,
                unique=True,
            ),
        ),
    ]
