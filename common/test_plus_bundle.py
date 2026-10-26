import json
import tempfile
from datetime import timedelta
from pathlib import Path

from common.authority import (
    ACTIVITY_STATE,
    CONTEST_ROUND_STATE,
    VOTE_BALLOT_WRITE,
    VOTE_SESSION_STATE,
    authority_write,
)
from core.models import Activity
from django.contrib.auth import get_user_model
from django.core.management import call_command
from django.test import TestCase
from django.utils import timezone
from singer_contest.models import ContestRound, Judge, ScoreRecord, SingerRegistration
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
        self.assertEqual(bundle["voting"]["sessions"][0]["options"][0]["legacyId"], option.pk)
        self.assertEqual(bundle["voting"]["ballots"][0]["optionLegacyIds"], [option.pk])
