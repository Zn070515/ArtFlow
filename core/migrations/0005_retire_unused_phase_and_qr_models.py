from django.db import migrations


def assert_retired_tables_are_empty(apps, schema_editor):
    database = schema_editor.connection.alias
    for model_name in ("ActivityPhase", "QRCodeLink"):
        model = apps.get_model("core", model_name)
        row_count = model.objects.using(database).count()
        if row_count:
            raise RuntimeError(
                f"Cannot retire core.{model_name}: {row_count} row(s) still exist."
            )


class Migration(migrations.Migration):
    dependencies = [
        ("core", "0004_alter_activity_options"),
    ]

    operations = [
        migrations.RunPython(assert_retired_tables_are_empty, migrations.RunPython.noop),
        migrations.DeleteModel(name="QRCodeLink"),
        migrations.DeleteModel(name="ActivityPhase"),
    ]
