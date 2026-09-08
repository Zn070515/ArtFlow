import json
from pathlib import Path
from tempfile import TemporaryDirectory

from accounts.models import User
from core.models import Activity
from django.core.management import call_command
from django.test import TestCase
from singer_contest.models import (
    ContestRound,
    Judge,
    JudgeSeat,
    JudgeSeatGrant,
    JudgeSession,
    RoundJudge,
    RoundPanelSnapshot,
    RoundPanelSnapshotMember,
)

from common.authority import ACCOUNT_AUTHORITY, authority_write
from common.test_data import clear_activity_test_data


class JudgeTestDataCleanupTests(TestCase):
    def test_prepared_judge_fixture_can_be_cleared_through_test_authority(self) -> None:
        with authority_write(ACCOUNT_AUTHORITY):
            operator = User.objects.create_superuser(
                username="judge-cleanup-operator",
                email="judge-cleanup@example.test",
                password="unused",
            )  # type: ignore[no-untyped-call]

        with TemporaryDirectory() as directory:
            fixture_path = Path(directory) / "judge-fixture.json"
            call_command("prepare_judge_e2e", output_file=str(fixture_path))
            activity_id = json.loads(fixture_path.read_text(encoding="utf-8"))["activity_id"]

        activity = Activity.objects.get(pk=activity_id)
        contest_round = ContestRound.objects.get(activity=activity)
        self.assertTrue(RoundPanelSnapshot.objects.filter(round=contest_round).exists())

        clear_activity_test_data(activity, operator=operator)

        self.assertFalse(RoundPanelSnapshot.objects.filter(round=contest_round).exists())
        self.assertFalse(
            RoundPanelSnapshotMember.objects.filter(panel_snapshot__round=contest_round).exists()
        )
        self.assertFalse(
            JudgeSeat.objects.filter(panel_member__panel_snapshot__round=contest_round).exists()
        )
        self.assertFalse(
            JudgeSeatGrant.objects.filter(panel_snapshot__round=contest_round).exists()
        )
        self.assertFalse(JudgeSession.objects.filter(panel_snapshot__round=contest_round).exists())
        self.assertFalse(RoundJudge.objects.filter(round=contest_round).exists())
        self.assertTrue(Judge.objects.filter(activity=activity).exists())
