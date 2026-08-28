from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ("core", "0003_activity_data_lifecycle"),
    ]

    operations = [
        migrations.AlterModelOptions(
            name="activity",
            options={
                "base_manager_name": "objects",
                "ordering": ["-created_at"],
                "verbose_name_plural": "activities",
            },
        ),
    ]
