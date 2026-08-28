from django.db import migrations, models


def backfill_activity_data_lifecycle(apps, schema_editor):
    Activity = apps.get_model("core", "Activity")
    Activity.objects.filter(is_test_mode=True).update(data_lifecycle="test")
    Activity.objects.filter(is_test_mode=False).update(data_lifecycle="formal")


class Migration(migrations.Migration):

    dependencies = [
        ("core", "0002_activityphase_qrcodelink"),
    ]

    operations = [
        migrations.AddField(
            model_name="activity",
            name="data_lifecycle",
            field=models.CharField(
                choices=[("test", "测试数据"), ("formal", "正式数据")],
                default="test",
                max_length=12,
            ),
        ),
        migrations.RunPython(backfill_activity_data_lifecycle, migrations.RunPython.noop),
    ]
