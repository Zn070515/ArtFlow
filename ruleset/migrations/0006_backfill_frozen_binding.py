"""Backfill a binding snapshot onto FROZEN ruleset versions (§45 M1-R1).

Pre-R1 frozen versions carried their binding (stage_key / round_keys /
announcement_blocks) only on the mutable ContestRuleset. To make a frozen version
self-authoritative, copy those fields into ``version.binding`` so the runtime reads
the snapshot and never the still-editable ruleset fields. Rows that already carry a
snapshot (or whose ruleset has no binding) are left untouched.
"""

from django.db import migrations


def _backfill_binding(apps, schema_editor):
    RulesetVersion = apps.get_model("ruleset", "RulesetVersion")
    for version in RulesetVersion.objects.filter(status="frozen").select_related("ruleset"):
        if version.binding:
            continue
        ruleset = version.ruleset
        snapshot = {
            "stage_key": ruleset.stage_key or "",
            "round_keys": ruleset.round_keys or {},
            "announcement_blocks": ruleset.announcement_blocks or [],
        }
        if not any(snapshot.values()):
            continue
        RulesetVersion.objects.filter(pk=version.pk).update(binding=snapshot)


def _noop(apps, schema_editor):
    pass


class Migration(migrations.Migration):

    dependencies = [
        ("ruleset", "0005_rulesetversion_binding"),
    ]

    operations = [
        migrations.RunPython(_backfill_binding, _noop),
    ]
