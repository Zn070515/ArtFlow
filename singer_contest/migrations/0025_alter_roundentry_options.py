from django.db import migrations


class Migration(migrations.Migration):
    dependencies = [
        ("singer_contest", "0024_award_stage_provenance"),
    ]

    operations = [
        migrations.AlterModelOptions(
            name="roundentry",
            options={
                "ordering": ["running_order", "pk"],
                "base_manager_name": "objects",
            },
        ),
    ]
