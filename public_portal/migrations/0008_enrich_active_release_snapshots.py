from django.db import migrations

OUTCOME_LABELS = {
    "direct": "直接晋级",
    "advanced": "晋级",
    "repechage": "复活赛",
    "pending": "待定",
    "eliminated": "淘汰",
    "wildcard": "外卡",
    "finalist": "最终晋级",
}


def enrich_active_snapshots(apps, schema_editor):
    """Add display fields to ACTIVE snapshots written before they were frozen.

    Only ACTIVE releases are enriched: they still describe the current confirmed result,
    so the current singer rows are the same people that snapshot named. SUPERSEDED and
    REVOKED rows must keep their sparse historical shape rather than inherit today's names.
    """

    ResultRelease = apps.get_model("public_portal", "ResultRelease")
    SingerRegistration = apps.get_model("singer_contest", "SingerRegistration")

    for release in ResultRelease.objects.filter(status="active"):
        snapshot = release.result_snapshot or {}
        decisions = snapshot.get("decisions") or []
        awards = snapshot.get("awards") or []
        singer_ids = set()
        for row in [*decisions, *awards]:
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
            if "contestant_name" in row:
                continue
            raw = row.get("contestant_id", row.get("contestant"))
            try:
                singer_id = int(raw)
            except (TypeError, ValueError):
                continue
            singer = singers.get(singer_id)
            row["contestant_id"] = singer_id
            row["contestant_name"] = singer.name if singer is not None else str(singer_id)
            row.setdefault("song_label", singer.song_name if singer is not None else "")
            row.setdefault(
                "outcome_label",
                OUTCOME_LABELS.get(row.get("outcome_code"), row.get("outcome_code", "")),
            )
            changed = True
        for row in awards:
            if "contestant_name" in row:
                continue
            raw = row.get("contestant_id", row.get("contestant"))
            try:
                singer_id = int(raw)
            except (TypeError, ValueError):
                continue
            singer = singers.get(singer_id)
            row["contestant_id"] = singer_id
            row["contestant_name"] = singer.name if singer is not None else str(singer_id)
            changed = True
        if changed:
            release.result_snapshot = snapshot
            release.save(update_fields=["result_snapshot"])


class Migration(migrations.Migration):
    dependencies = [
        ("public_portal", "0007_backfill_resultrelease_candidate_snapshot"),
        ("singer_contest", "0061_stageresult_candidate_revision"),
    ]

    operations = [
        migrations.RunPython(enrich_active_snapshots, migrations.RunPython.noop),
    ]
