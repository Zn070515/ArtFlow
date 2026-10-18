from django.db import migrations


def backfill_active_releases(apps, schema_editor):
    """Give existing ACTIVE releases the baseline the new idempotency check compares.

    An ACTIVE release still points at the current CONFIRMED StageResult, and a confirmed
    result cannot be re-materialized in place, so its current candidate revision and
    decisions are exactly what that release published. SUPERSEDED/REVOKED rows are left
    empty on purpose: their StageResult may have been rewritten since, and inventing a
    historical snapshot would be worse than marking it unavailable.
    """

    ResultRelease = apps.get_model("public_portal", "ResultRelease")
    StageDecision = apps.get_model("singer_contest", "StageDecision")
    StageAwardDecision = apps.get_model("singer_contest", "StageAwardDecision")

    active = ResultRelease.objects.filter(status="active").select_related("stage_result")
    for release in active:
        stage = release.stage_result
        release.candidate_revision = stage.candidate_revision or 0
        release.result_snapshot = {
            "stage_key": stage.stage_key,
            "result_version": stage.result_version,
            "candidate_revision": stage.candidate_revision or 0,
            "input_fingerprint": stage.input_fingerprint,
            "ruleset_version_id": stage.ruleset_version_id,
            "decisions": [
                {
                    "rank": decision.rank,
                    "contestant": str(decision.singer_id),
                    "outcome_code": decision.outcome_code,
                    "score": str(decision.score) if decision.score is not None else None,
                    "reason": decision.reason,
                }
                for decision in StageDecision.objects.filter(stage_result_id=stage.pk).order_by(
                    "rank", "pk"
                )
            ],
            "awards": [
                {
                    "award": award.name,
                    "contestant": str(award.singer_id),
                    "source_node": award.source_node,
                }
                for award in StageAwardDecision.objects.filter(stage_result_id=stage.pk).order_by(
                    "name", "pk"
                )
            ],
        }
        release.save(update_fields=["candidate_revision", "result_snapshot"])


class Migration(migrations.Migration):
    dependencies = [
        ("public_portal", "0006_resultrelease_candidate_revision_and_more"),
        ("singer_contest", "0061_stageresult_candidate_revision"),
    ]

    operations = [
        migrations.RunPython(backfill_active_releases, migrations.RunPython.noop),
    ]
