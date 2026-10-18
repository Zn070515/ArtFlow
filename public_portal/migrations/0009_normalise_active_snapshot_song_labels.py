import json

from django.db import migrations


def normalise_active_snapshot_song_labels(apps, schema_editor):
    """Bring 0007/0008 snapshots in line with the current song-label semantics.

    New releases use ``generic_song_label``: a questionnaire-backed format labels the
    entry "多轮曲目" rather than falling back to the legacy single ``song_name`` column.
    ACTIVE releases still describe the current format, so they can be normalised the same
    way; superseded/revoked rows keep their sparse historical shape.
    """

    ResultRelease = apps.get_model("public_portal", "ResultRelease")
    SingerRegistration = apps.get_model("singer_contest", "SingerRegistration")

    for release in ResultRelease.objects.filter(status="active").select_related("ruleset_version"):
        snapshot = release.result_snapshot or {}
        decisions = snapshot.get("decisions") or []
        if not decisions:
            continue
        try:
            definition = json.loads(release.ruleset_version.definition or "{}")
        except (TypeError, ValueError):
            definition = {}
        has_questionnaire = bool(isinstance(definition, dict) and definition.get("questionnaire"))
        singer_ids = set()
        for row in decisions:
            raw = row.get("contestant_id", row.get("contestant"))
            try:
                singer_ids.add(int(raw))
            except (TypeError, ValueError):
                continue
        singers = {
            singer.pk: singer for singer in SingerRegistration.objects.filter(pk__in=singer_ids)
        }
        changed = False
        for row in decisions:
            raw = row.get("contestant_id", row.get("contestant"))
            try:
                singer = singers.get(int(raw))
            except (TypeError, ValueError):
                singer = None
            label = (
                "多轮曲目"
                if has_questionnaire
                else (singer.song_name if singer is not None else row.get("song_label", ""))
            )
            if row.get("song_label") != label:
                row["song_label"] = label
                changed = True
        if changed:
            release.result_snapshot = snapshot
            release.save(update_fields=["result_snapshot"])


class Migration(migrations.Migration):
    dependencies = [
        ("public_portal", "0008_enrich_active_release_snapshots"),
        ("singer_contest", "0061_stageresult_candidate_revision"),
    ]

    operations = [
        migrations.RunPython(normalise_active_snapshot_song_labels, migrations.RunPython.noop),
    ]
