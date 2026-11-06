import json
import tempfile
from datetime import timedelta
from pathlib import Path

from common.authority import (
    ACCOUNT_AUTHORITY,
    ACTIVITY_STATE,
    CONTEST_ROUND_STATE,
    RESULT_RELEASE_STATE,
    RULESET_FREEZE,
    STAGE_RESULT_CONFIRM,
    STAGE_RESULT_RESOLVE,
    VOTE_BALLOT_WRITE,
    VOTE_SESSION_STATE,
    authority_write,
)
from core.models import Activity
from django.contrib.auth import get_user_model
from django.core.management import call_command
from django.test import TestCase
from django.utils import timezone
from files.models import MaterialCheck, SubmissionFile
from public_portal.models import PublicPost, ResultRelease
from ruleset.models import ContestRuleset, RulesetVersion
from singer_contest.group_chorus import (
    confirm_group_stage,
    create_group_stage,
    freeze_group_stage,
    record_group_stage,
)
from singer_contest.models import (
    ContestRound,
    Judge,
    ScoreRecord,
    SingerRegistration,
    StageAwardDecision,
    StageDecision,
    StageResult,
)
from voting.models import VoteBallot, VoteOption, VoteRecord, VoteSession


class ExportPlusBundleTests(TestCase):
    def _activity(self) -> Activity:
        with authority_write(ACTIVITY_STATE):
            return Activity.objects.create(
                title="2025 院十佳",
                activity_type=Activity.Type.SINGER_CONTEST,
                phase=Activity.Phase.REGISTRATION_CLOSED,
                public_code="LEG2025",
                is_test_mode=False,
            )

    def _registration(self, activity: Activity, name: str, *, test_data: bool = False):
        user = get_user_model().objects.create_user(
            username=f"legacy-{name}", password="participant-password"
        )
        return SingerRegistration.objects.create(
            activity=activity,
            user=user,
            name=name,
            student_id=f"2025{name}",
            college="信息学院",
            class_name="1 班",
            phone="13800000000",
            pre_status=SingerRegistration.PreStatus.APPROVED,
            is_test_data=test_data,
        )

    def test_export_skips_test_rows_and_never_copies_secrets(self) -> None:
        activity = self._activity()
        self._registration(activity, "Alice")
        self._registration(activity, "TestOnly", test_data=True)
        output = Path(tempfile.mkdtemp()) / "bundle.json"

        call_command("export_plus_bundle", activity="LEG2025", output=str(output))

        bundle = json.loads(output.read_text(encoding="utf-8"))
        self.assertEqual(bundle["format"], "artflow-plus-legacy-bundle")
        self.assertEqual(bundle["version"], 1)
        self.assertEqual(bundle["counts"]["registrations"], 1)
        self.assertEqual(bundle["counts"]["approvedRegistrations"], 1)
        self.assertEqual(bundle["excluded"]["testRegistrations"], 1)
        self.assertEqual(len(bundle["registrations"]), 1)
        self.assertEqual(bundle["registrations"][0]["answers"]["name"], "Alice")
        serialized = output.read_text(encoding="utf-8")
        for forbidden in ("password", "token", "session_key", "ip_address"):
            self.assertNotIn(forbidden, serialized)

    def test_export_includes_rounds_and_scores(self) -> None:
        activity = self._activity()
        singer = self._registration(activity, "Alice")
        judge = Judge.objects.create(activity=activity, name="评委甲")
        with authority_write(CONTEST_ROUND_STATE):
            round_row = ContestRound.objects.create(
                activity=activity,
                round_type=ContestRound.RoundType.PRELIMINARY,
                sequence=1,
                status=ContestRound.Status.SCORING,
                judge_count=1,
            )
        ScoreRecord.objects.create(
            round=round_row,
            singer=singer,
            judge=judge,
            score="91.50",
            notes="稳定",
        )
        output = Path(tempfile.mkdtemp()) / "bundle.json"

        call_command("export_plus_bundle", activity="LEG2025", output=str(output))

        bundle = json.loads(output.read_text(encoding="utf-8"))
        self.assertEqual(bundle["counts"]["rounds"], 1)
        self.assertEqual(bundle["counts"]["scores"], 1)
        self.assertEqual(len(bundle["rounds"]), 1)
        self.assertEqual(bundle["rounds"][0]["key"], f"round-{round_row.pk}")
        self.assertEqual(bundle["competition"]["scores"][0]["total"], "91.50")
        self.assertEqual(bundle["competition"]["scores"][0]["criteria"], {"总分": 91.5})
        self.assertEqual(bundle["roster"]["status"], "final")
        self.assertEqual(bundle["roster"]["approvedCount"], 1)

    def test_export_includes_vote_sessions_and_ballots(self) -> None:
        activity = self._activity()
        singer = self._registration(activity, "Alice")
        now = timezone.now()
        with authority_write(VOTE_SESSION_STATE), authority_write(VOTE_BALLOT_WRITE):
            session = VoteSession.objects.create(
                activity=activity,
                name="人气投票",
                start_time=now,
                end_time=now + timedelta(hours=1),
                is_open=False,
                selection_type=VoteSession.SelectionType.SINGLE,
                max_selections=1,
                purpose=VoteSession.Purpose.SELECTION,
            )
            option = VoteOption.objects.create(
                vote_session=session,
                singer=singer,
                sort_order=1,
            )
            VoteSession.objects.filter(pk=session.pk).update(is_open=True)
            session.refresh_from_db()
            key = "b" * 32
            ballot = VoteBallot.objects.create(
                vote_session=session,
                browser_session_key=key,
                ip_address="127.0.0.1",
            )
            VoteRecord.objects.create(
                ballot=ballot,
                vote_session=session,
                vote_option=option,
                browser_session_key=key,
                ip_address="127.0.0.1",
            )
        output = Path(tempfile.mkdtemp()) / "bundle.json"

        call_command("export_plus_bundle", activity="LEG2025", output=str(output))

        bundle = json.loads(output.read_text(encoding="utf-8"))
        self.assertEqual(bundle["counts"]["ballots"], 1)
        self.assertEqual(len(bundle["voting"]["sessions"]), 1)
        self.assertEqual(bundle["voting"]["sessions"][0]["status"], "open")
        self.assertEqual(bundle["voting"]["sessions"][0]["purpose"], "popularity")
        self.assertEqual(bundle["voting"]["sessions"][0]["options"][0]["legacyId"], option.pk)
        self.assertEqual(bundle["voting"]["ballots"][0]["optionLegacyIds"], [option.pk])
        self.assertIn(
            "vote_purpose_mapped",
            {entry["kind"] for entry in bundle["unsupported"]},
        )

    def test_export_preserves_camel_case_result_snapshot_fallback_ids(self) -> None:
        activity = self._activity()
        singer = self._registration(activity, "Alice")
        operator = get_user_model().objects.create_user(
            username="result-export-operator", password="staff-password"
        )
        ruleset = ContestRuleset.objects.create(
            activity=activity,
            name="Export ruleset",
            stage_key="final",
        )
        with authority_write(RULESET_FREEZE):
            ruleset_version = RulesetVersion.objects.create(
                ruleset=ruleset,
                version=1,
                definition={
                    "schema_version": 1,
                    "nodes": [{"key": "release-stage", "type": "ASSESS", "source": "entry", "vote_source": "release-source"}],
                },
                status=RulesetVersion.Status.FROZEN,
                is_current=True,
                authority_hash="a" * 64,
            )
        with authority_write(STAGE_RESULT_RESOLVE), authority_write(STAGE_RESULT_CONFIRM):
            stage_result = StageResult.objects.create(
                activity=activity,
                ruleset_version=ruleset_version,
                stage_key="final",
                status=StageResult.Status.READY_TO_CONFIRM,
                ruleset_hash="a" * 64,
                input_fingerprint="b" * 64,
                result_version=1,
                is_test_data=False,
            )
            StageDecision.objects.create(
                stage_result=stage_result,
                singer=singer,
                outcome_code="finalist",
                rank=1,
                score="93.50",
            )
            StageAwardDecision.objects.create(
                stage_result=stage_result,
                activity=activity,
                singer=singer,
                name="冠军",
            )
            stage_result.status = StageResult.Status.CONFIRMED
            stage_result.confirmed_at = timezone.now()
            stage_result.confirmed_by = operator
            stage_result.save(update_fields=["status", "confirmed_at", "confirmed_by"])
        post = PublicPost.objects.create(
            title="Final result",
            post_type=PublicPost.PostType.RESULT_PUBLICATION,
            status=PublicPost.Status.PUBLISHED,
            related_activity=activity,
            version=1,
        )
        with authority_write(RESULT_RELEASE_STATE):
            ResultRelease.objects.create(
                post=post,
                stage_result=stage_result,
                post_version=1,
                result_version=1,
                candidate_revision=stage_result.candidate_revision,
                # The current schema normalizes a legacy NULL snapshot to the
                # empty JSON object; the exporter must still use the fallback.
                result_snapshot={},
                ruleset_version=ruleset_version,
                authority_hash="a" * 64,
                input_fingerprint="b" * 64,
                status=ResultRelease.Status.ACTIVE,
                released_by=operator,
                note="export fallback",
            )
        output = Path(tempfile.mkdtemp()) / "bundle.json"

        call_command("export_plus_bundle", activity=activity.public_code, output=str(output))

        bundle = json.loads(output.read_text(encoding="utf-8"))
        snapshot = bundle["results"]["releases"][0]["snapshot"]
        expected_id = f"legacy-user:{singer.user_id}"
        self.assertEqual(snapshot["decisions"][0]["contestantId"], expected_id)
        self.assertEqual(snapshot["awards"][0]["contestantId"], expected_id)
        self.assertNotIn("legacy-user:None", output.read_text(encoding="utf-8"))

    def test_export_includes_grouping_stages(self) -> None:
        activity = self._activity()
        alice = self._registration(activity, "Alice")
        bob = self._registration(activity, "Bob")
        with authority_write(ACTIVITY_STATE):
            Activity.objects.filter(pk=activity.pk).update(phase=Activity.Phase.REHEARSAL)
        with authority_write(ACCOUNT_AUTHORITY):
            staff = get_user_model().objects.create_user(
                username="export-staff", password="staff-password", role="admin"
            )
        stage = create_group_stage(
            activity, stage_key="chorus", name="分组合唱", operator=staff
        )
        record_group_stage(
            stage,
            [
                {"name": "A 组", "singer_ids": [alice.pk]},
                {"name": "B 组", "singer_ids": [bob.pk]},
            ],
            staff,
        )
        confirm_group_stage(stage, staff)
        freeze_group_stage(stage, staff)
        output = Path(tempfile.mkdtemp()) / "bundle.json"

        call_command("export_plus_bundle", activity="LEG2025", output=str(output))

        bundle = json.loads(output.read_text(encoding="utf-8"))
        self.assertEqual(len(bundle["grouping"]), 1)
        self.assertEqual(bundle["grouping"][0]["status"], "frozen")
        self.assertEqual(bundle["grouping"][0]["materialWindow"], "closed")
        self.assertEqual(len(bundle["grouping"][0]["groups"]), 2)
        kinds = {entry["kind"] for entry in bundle["unsupported"]}
        self.assertNotIn("group_stage", kinds)

    def test_export_includes_material_metadata(self) -> None:
        activity = self._activity()
        singer = self._registration(activity, "Alice")
        submission = SubmissionFile.objects.create(
            singer_registration=singer,
            file="submissions/2025/10/song.mp3",
            original_name="song.mp3",
            file_size=1234,
            file_purpose=SubmissionFile.Purpose.ACCOMPANIMENT,
            question_key="audio",
        )
        MaterialCheck.objects.create(
            singer_registration=singer,
            item_name="音频材料",
            question_key="audio",
            file_purpose=SubmissionFile.Purpose.ACCOMPANIMENT,
            status=MaterialCheck.Status.APPROVED,
            required=True,
            review_note="clear",
        )
        output = Path(tempfile.mkdtemp()) / "bundle.json"

        call_command("export_plus_bundle", activity="LEG2025", output=str(output))

        bundle = json.loads(output.read_text(encoding="utf-8"))
        self.assertEqual(bundle["counts"]["materials"], 1)
        self.assertEqual(bundle["materials"][0]["legacyId"], submission.pk)
        self.assertEqual(bundle["materials"][0]["questionKey"], "audio")
        self.assertEqual(bundle["materials"][0]["originalName"], "song.mp3")
        self.assertEqual(bundle["materials"][0]["contentType"], "audio/mpeg")
        self.assertEqual(bundle["materials"][0]["byteLength"], 1234)
        self.assertEqual(bundle["materials"][0]["status"], "approved")
        self.assertEqual(bundle["materials"][0]["reviewNote"], "clear")
