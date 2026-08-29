from django.db import migrations, models
from django.db.models import Count


def _dedupe_groups(apps, owner_field):
    MaterialCheck = apps.get_model("files", "MaterialCheck")
    groups = (
        MaterialCheck.objects.filter(**{f"{owner_field}__isnull": False})
        .values(owner_field, "item_name")
        .annotate(total=Count("pk"))
        .filter(total__gt=1)
    )
    for group in groups:
        ids = list(
            MaterialCheck.objects.filter(
                **{owner_field: group[owner_field], "item_name": group["item_name"]}
            )
            .order_by("-pk")
            .values_list("pk", flat=True)
        )
        if len(ids) > 1:
            MaterialCheck.objects.filter(pk__in=ids[1:]).delete()


def dedupe_material_checks(apps, schema_editor):
    """Collapse pre-existing duplicate (owner, item_name) rows deterministically.

    Concurrent reconciliation could create more than one MaterialCheck row per
    (owner, item_name) before the conditional unique constraints existed. Keep the
    highest-pk row (the most recently written) per group and delete the rest so the
    AddConstraint below cannot raise on production.
    """
    _dedupe_groups(apps, "singer_registration_id")
    _dedupe_groups(apps, "program_id")


class Migration(migrations.Migration):

    dependencies = [
        ("farewell_show", "0002_program_is_test_data"),
        ("files", "0008_materialcheck_review_note_materialcheck_reviewed_at_and_more"),
        ("singer_contest", "0010_contestround_advancement_status"),
    ]

    operations = [
        migrations.RunPython(dedupe_material_checks, migrations.RunPython.noop),
        migrations.AddConstraint(
            model_name="materialcheck",
            constraint=models.UniqueConstraint(
                condition=models.Q(("singer_registration__isnull", False)),
                fields=("singer_registration", "item_name"),
                name="materialcheck_unique_singer_item",
            ),
        ),
        migrations.AddConstraint(
            model_name="materialcheck",
            constraint=models.UniqueConstraint(
                condition=models.Q(("program__isnull", False)),
                fields=("program", "item_name"),
                name="materialcheck_unique_program_item",
            ),
        ),
    ]
