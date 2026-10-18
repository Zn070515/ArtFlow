"""The release snapshot columns must upgrade an existing, already-published database."""

import json
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import patch

from accounts.models import User
from common.authority import (
    ACCOUNT_AUTHORITY,
    ACTIVITY_STATE,
    RULESET_FREEZE,
    STAGE_RESULT_CONFIRM,
    STAGE_RESULT_RESOLVE,
    authority_write,
)
from core.models import Activity
from django.db import connection
from django.db.migrations.executor import MigrationExecutor
from django.utils import timezone
from ruleset.models import ContestRuleset, RulesetVersion
from singer_contest.models import SingerRegistration, StageDecision, StageResult
from tests.migration_helpers import MigrationTransactionTestCase

from public_portal.models import PublicPost

BEFORE = ("public_portal", "0005_media_path_indexes")
AFTER = ("public_portal", "0009_normalise_active_snapshot_song_labels")


class ResultReleaseSnapshotBackfillTests(MigrationTransactionTestCase):
    """Only public_portal is rolled back; every other app stays at its current schema.

    That is the real upgrade shape: the database already has StageResult.candidate_revision
    and the rest of the current schema, and only the release rows predate their snapshot
    columns.
    """

    def _migrate_to(self, targets):
        executor = MigrationExecutor(connection)
        executor.migrate(list(targets))
        return executor

    def _apps_at(self, target):
        return MigrationExecutor(connection).loader.project_state([target]).apps

    def _restore_latest(self):
        executor = MigrationExecutor(connection)
        executor.migrate(executor.loader.graph.leaf_nodes())

    def test_an_active_release_gains_its_published_candidate_snapshot(self):
        try:
            self._migrate_to([BEFORE])
            legacy_apps = self._apps_at(BEFORE)
            LegacyRelease = legacy_apps.get_model("public_portal", "ResultRelease")

            with authority_write(ACCOUNT_AUTHORITY):
                user = User.objects.create_user(
                    username="release-migration", password="pass", role=User.Role.ADMIN
                )
            with authority_write(ACTIVITY_STATE):
                activity = Activity.objects.create(
                    title="Release migration",
                    activity_type=Activity.Type.SINGER_CONTEST,
                    phase=Activity.Phase.RESULTS_PENDING,
                    is_test_mode=False,
                )
            ruleset = ContestRuleset.objects.create(activity=activity, name="Migration rules")
            with authority_write(RULESET_FREEZE):
                version = RulesetVersion.objects.create(
                    ruleset=ruleset,
                    version=1,
                    status=RulesetVersion.Status.FROZEN,
                    is_current=True,
                    definition=json.dumps(
                        {
                            "schema_version": 1,
                            "nodes": [{"key": "roster", "type": "ROSTER"}],
                            "questionnaire": {
                                "schema_version": 1,
                                "key": "singer_submission",
                                "pages": [
                                    {
                                        "key": "basic",
                                        "title": "基本信息",
                                        "sections": [
                                            {
                                                "key": "identity",
                                                "title": "身份",
                                                "questions": [
                                                    {
                                                        "key": "name",
                                                        "type": "text",
                                                        "label": "name",
                                                    }
                                                ],
                                            }
                                        ],
                                    }
                                ],
                            },
                        },
                        ensure_ascii=False,
                    ),
                    authority_hash="a" * 64,
                )
            singer = SingerRegistration.objects.create(
                activity=activity,
                user=user,
                name="Migration singer",
                student_id="migration-001",
                college="Arts",
                class_name="Class 1",
                phone="13800000000",
                song_name="Song",
            )
            with authority_write(STAGE_RESULT_RESOLVE):
                stage = StageResult.objects.create(
                    activity=activity,
                    ruleset_version=version,
                    stage_key="final_podium",
                    status=StageResult.Status.READY_TO_CONFIRM,
                    result_version=1,
                    input_fingerprint="f" * 64,
                    ruleset_hash="a" * 64,
                )
                StageDecision.objects.create(
                    stage_result=stage,
                    singer=singer,
                    outcome_code="finalist",
                    rank=1,
                    score=Decimal("98.30"),
                )
            with authority_write(STAGE_RESULT_CONFIRM):
                stage.status = StageResult.Status.CONFIRMED
                stage.confirmed_by = user
                stage.confirmed_at = timezone.now()
                stage.save(update_fields=["status", "confirmed_by", "confirmed_at"])
            post = PublicPost.objects.create(
                title="Result publication",
                post_type=PublicPost.PostType.RESULT_PUBLICATION,
                status=PublicPost.Status.PUBLISHED,
                related_activity=activity,
                published_at=timezone.now(),
                version=1,
            )
            # The legacy table has no candidate_revision / result_snapshot columns yet.
            release = LegacyRelease.objects.create(
                post_id=post.pk,
                stage_result_id=stage.pk,
                post_version=1,
                result_version=1,
                ruleset_version_id=version.pk,
                authority_hash="a" * 64,
                input_fingerprint="f" * 64,
                status="active",
                released_by_id=user.pk,
                note="legacy release",
            )
            release_pk = release.pk

            self._migrate_to([AFTER])
            after = self._apps_at(AFTER)
            ReleaseAfter = after.get_model("public_portal", "ResultRelease")
            migrated = ReleaseAfter.objects.get(pk=release_pk)

            self.assertEqual(migrated.candidate_revision, stage.candidate_revision)
            snapshot = migrated.result_snapshot
            self.assertEqual(snapshot["stage_key"], "final_podium")
            self.assertEqual(snapshot["decisions"][0]["contestant"], str(singer.pk))
            self.assertEqual(snapshot["decisions"][0]["score"], "98.300000")
            self.assertEqual(snapshot["decisions"][0]["contestant_name"], "Migration singer")
            self.assertEqual(snapshot["decisions"][0]["outcome_label"], "最终晋级")
            self.assertEqual(snapshot["decisions"][0]["song_label"], "多轮曲目")
            self.assertEqual(snapshot["awards"], [])

            self._restore_latest()
            from public_portal.models import ResultRelease as CurrentRelease
            from public_portal.services import release_result_post

            with patch(
                "public_portal.services.build_result_closure",
                return_value=SimpleNamespace(closeable=True),
            ):
                again = release_result_post(post, stage, user, note="再次发布同一结果")

            self.assertEqual(again.pk, release_pk)
            self.assertEqual(CurrentRelease.objects.filter(status="active").count(), 1)
        finally:
            self._restore_latest()
