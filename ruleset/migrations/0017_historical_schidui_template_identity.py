"""§11.1 — make ``builtin_key`` the built-in templates' stable identity.

The 2025 院十佳 template's *display* name changes to mark it as a historical template. A
database that already holds the row must be upgraded in place, so this migration:

1. adopts a legacy row that still has an empty ``builtin_key`` — only on an exact name
   match of a single such row, and only when no other row already owns the key (never a
   fuzzy title guess, and never a second row for one built-in);
2. renames the ``golden_schidui`` row in place.

The definition itself is untouched: the historical weights stay exactly as they were.
"""

from django.db import migrations

GOLDEN_SCHIDUI_BUILTIN_KEY = "golden_schidui"
HISTORICAL_SCHIDUI_NAME = "院十佳 2025（历史模板）"
LEGACY_TEMPLATE_NAMES = {"院十佳": GOLDEN_SCHIDUI_BUILTIN_KEY}


def _upgrade_template_identity(apps, schema_editor):
    RulesetTemplate = apps.get_model("ruleset", "RulesetTemplate")

    for legacy_name, builtin_key in LEGACY_TEMPLATE_NAMES.items():
        if RulesetTemplate.objects.filter(builtin_key=builtin_key).exists():
            continue
        candidates = RulesetTemplate.objects.filter(name=legacy_name, builtin_key="")
        if candidates.count() != 1:
            continue
        row = candidates.first()
        row.builtin_key = builtin_key
        row.save(update_fields=["builtin_key"])

    RulesetTemplate.objects.filter(builtin_key=GOLDEN_SCHIDUI_BUILTIN_KEY).update(
        name=HISTORICAL_SCHIDUI_NAME
    )


class Migration(migrations.Migration):
    dependencies = [
        ("ruleset", "0016_contestruleset_vote_scoring_rule_keys"),
    ]

    operations = [
        migrations.RunPython(_upgrade_template_identity, migrations.RunPython.noop),
    ]
