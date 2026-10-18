from django.db import migrations


def backfill_active_snapshot_public_identity(apps, schema_editor):
    """Freeze the public identity for ACTIVE releases published before it was stored.

    ACTIVE releases still describe the current confirmed result, so the current activity
    title is the title that result is published under. Superseded/revoked rows stay
    sparse: their historical public title cannot be reconstructed.
    """

    ResultRelease = apps.get_model("public_portal", "ResultRelease")

    for release in ResultRelease.objects.filter(status="active").select_related(
        "stage_result__activity"
    ):
        snapshot = release.result_snapshot or {}
        if snapshot.get("public_title"):
            continue
        activity = release.stage_result.activity
        snapshot["activity_id"] = activity.pk
        snapshot["activity_title"] = activity.title
        snapshot["public_title"] = f"{activity.title} · 正式赛果"
        release.result_snapshot = snapshot
        release.save(update_fields=["result_snapshot"])


class Migration(migrations.Migration):
    dependencies = [
        ("public_portal", "0010_alter_publicmedia_options_alter_publicpost_options_and_more"),
        ("singer_contest", "0061_stageresult_candidate_revision"),
    ]

    operations = [
        migrations.RunPython(backfill_active_snapshot_public_identity, migrations.RunPython.noop),
    ]
