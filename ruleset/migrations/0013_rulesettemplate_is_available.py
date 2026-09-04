from django.db import migrations, models


def retire_non_production_builtins(apps, schema_editor):
    RulesetTemplate = apps.get_model("ruleset", "RulesetTemplate")
    RulesetTemplate.objects.filter(
        name__in=("独立人气奖", "校十佳屏峰_历史未决回退")
    ).update(is_available=False)


class Migration(migrations.Migration):
    dependencies = [
        ("ruleset", "0012_contestruleset_audience_keys"),
    ]

    operations = [
        migrations.AddField(
            model_name="rulesettemplate",
            name="is_available",
            field=models.BooleanField(
                default=True,
                help_text="是否在生产模板库中可选择；撤下的内置模板保留用于历史追溯。",
            ),
        ),
        migrations.RunPython(retire_non_production_builtins, migrations.RunPython.noop),
    ]
