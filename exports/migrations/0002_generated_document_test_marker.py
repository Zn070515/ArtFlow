from django.db import migrations, models


def backfill_generated_document_test_marker(apps, schema_editor):
    GeneratedDocument = apps.get_model("exports", "GeneratedDocument")
    GeneratedDocument.objects.filter(activity__is_test_mode=True).update(is_test_data=True)


class Migration(migrations.Migration):
    dependencies = [
        ("core", "0003_activity_data_lifecycle"),
        ("exports", "0001_initial"),
    ]

    operations = [
        migrations.AddField(
            model_name="generateddocument",
            name="is_test_data",
            field=models.BooleanField(default=False),
        ),
        migrations.RunPython(backfill_generated_document_test_marker, migrations.RunPython.noop),
    ]
