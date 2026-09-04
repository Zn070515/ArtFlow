from django.db import migrations, models
from django.db.models import Q


def backfill_capability_truth(apps, schema_editor):
    RulesetTemplate = apps.get_model("ruleset", "RulesetTemplate")
    production = {"院十佳", "独立人气奖"}
    unsupported = {"校十佳屏峰_历史未决回退"}
    keys = {
        "院十佳": "golden_schidui",
        "合成_分组逐组补足演示": "synthetic_xiaofeng_group_fill",
        "校十佳屏峰_历史控制流": "historical_xiaofeng_control_flow",
        "校十佳屏峰_历史未决回退": "historical_xiaofeng_unresolved_fallback",
        "海选筛选单场": "simple_screening",
        "单场 Top-N": "single_round_topn",
        "多轮加权": "weighted_multiround",
        "评委+观众合成": "judge_audience_composite",
        "独立人气奖": "independent_popularity_award",
        "分组直晋+复活": "group_direct_repechage",
        "种子 PK+外卡": "seeded_pk_wildcard",
        "直晋+中段PK": "direct_bye_middle_pk",
        "赛道/队伍名额": "track_team_quota",
        "多场地合并": "multivenue_merge",
    }
    for template in RulesetTemplate.objects.all():
        if template.name in production:
            capability = "production"
        elif template.name in unsupported:
            capability = "unsupported"
        else:
            capability = "experimental"
        template.builtin_key = keys.get(template.name, "")
        template.capability_status = capability
        template.is_available = capability == "production"
        template.save(update_fields=["builtin_key", "capability_status", "is_available"])


class Migration(migrations.Migration):
    dependencies = [("ruleset", "0013_rulesettemplate_is_available")]

    operations = [
        migrations.AddField(
            model_name="rulesettemplate",
            name="builtin_key",
            field=models.CharField(
                blank=True,
                default="",
                help_text="内置模板的稳定能力标识；自定义模板留空。",
                max_length=100,
            ),
        ),
        migrations.AddField(
            model_name="rulesettemplate",
            name="capability_status",
            field=models.CharField(
                choices=[
                    ("production", "生产可用"),
                    ("experimental", "实验性"),
                    ("unsupported", "不支持"),
                ],
                default="experimental",
                help_text="模板实际已验证的运行能力，不代表仅凭 schema 可编译。",
                max_length=16,
            ),
        ),
        migrations.RunPython(backfill_capability_truth, migrations.RunPython.noop),
        migrations.AddConstraint(
            model_name="rulesettemplate",
            constraint=models.UniqueConstraint(
                condition=~Q(builtin_key=""),
                fields=("builtin_key",),
                name="ruleset_template_unique_builtin_key",
            ),
        ),
    ]
