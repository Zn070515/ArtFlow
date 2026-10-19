"""The one-time upgrade of an existing 2026 live-format DRAFT."""

import json
from io import StringIO

from accounts.models import User
from common.authority import RULESET_FREEZE, authority_write
from common.models import AuditLog
from common.test_characterization import _CharacterizationBase
from django.core.management import call_command
from django.core.management.base import CommandError
from questionnaire.models import QuestionnaireResponse
from singer_contest.models import SingerRegistration

from ruleset.live_format import LIVE_CHALLENGE_FORMAT_KEY
from ruleset.models import ContestRuleset, RulesetVersion
from ruleset.schema import ENTRY_KEY
from ruleset.templates import live_2026_questionnaire


def _old_participant_questionnaire() -> dict:
    document = live_2026_questionnaire()
    for page in document["pages"]:
        for section in page["sections"]:
            for question in section["questions"]:
                if question["key"] in {"r2.accompaniment", "r3.accompaniment"}:
                    question["label"] = question["key"].split(".")[0] + "伴奏"
                    question["file"] = {
                        "purpose": "accompaniment",
                        "extensions": [".mp3"],
                        "max_mb": 100,
                    }
    return document


class UpgradeLive2026QuestionnairesTests(_CharacterizationBase):
    def setUp(self):
        super().setUp()
        self.activity = self.make_activity(
            is_test_mode=True, title="升级 2026 问卷"
        )
        self.ruleset = ContestRuleset.objects.create(
            activity=self.activity,
            name="2026 赛制",
            is_test_data=True,
            live_challenge={"format_key": LIVE_CHALLENGE_FORMAT_KEY},
            round_keys={},
        )
        self.version = RulesetVersion.objects.create(
            ruleset=self.ruleset,
            definition=json.dumps(
                {
                    "schema_version": 1,
                    "nodes": [
                        {
                            "key": "assess_r1",
                            "type": "ASSESS",
                            "source": ENTRY_KEY,
                            "round": "r1",
                        }
                    ],
                    "questionnaire": _old_participant_questionnaire(),
                },
                ensure_ascii=False,
            ),
        )
        self.operator = User.objects.create_superuser(
            "upgrade-operator", "upgrade-operator@example.com", "pass"
        )

    def _run(self, *, dry_run=False):
        output = StringIO()
        call_command(
            "upgrade_live_2026_questionnaires",
            activity=self.activity.pk,
            operator_username=self.operator.username,
            dry_run=dry_run,
            stdout=output,
        )
        return output.getvalue()

    def _root(self):
        self.version.refresh_from_db()
        return json.loads(self.version.definition)

    def test_dry_run_writes_nothing(self):
        before = self.version.definition

        output = self._run(dry_run=True)

        self.assertIn("dry run", output)
        self.version.refresh_from_db()
        self.assertEqual(self.version.definition, before)

    def test_apply_updates_personal_questions_and_adds_the_group_questionnaire(self):
        self._run()

        root = self._root()
        self.assertIn("group_questionnaire", root)
        questions = {
            question["key"]: question
            for page in root["questionnaire"]["pages"]
            for section in page["sections"]
            for question in section["questions"]
        }
        for key in ("r2.accompaniment", "r3.accompaniment"):
            self.assertIn(".mp4", questions[key]["file"]["extensions"])
            self.assertEqual(
                questions[key]["file"]["accepts"], ["performance_video"]
            )
        self.assertEqual(
            [q["key"] for q in root["group_questionnaire"]["pages"][0]["sections"][0]["questions"]],
            ["group.song", "group.media"],
        )
        self.assertTrue(
            AuditLog.objects.filter(
                target=f"RulesetVersion:{self.version.pk}",
                note="upgrade_live_2026_questionnaires",
            ).exists()
        )

    def test_second_run_is_idempotent(self):
        self._run()
        after_first = self._root()

        output = self._run(dry_run=True)

        self.assertIn("already up to date", output)
        self.assertEqual(self._root(), after_first)

    def test_a_frozen_version_is_refused(self):
        with authority_write(RULESET_FREEZE):
            RulesetVersion._base_manager.filter(pk=self.version.pk).update(
                status=RulesetVersion.Status.FROZEN
            )

        with self.assertRaisesMessage(CommandError, "no DRAFT"):
            self._run()

    def test_a_non_live_2026_ruleset_is_refused(self):
        self.ruleset.live_challenge = {}
        self.ruleset.save(update_fields=["live_challenge"])

        with self.assertRaisesMessage(CommandError, "not the 2026 live format"):
            self._run()

    def test_a_draft_with_responses_is_refused(self):
        user = self.make_user("upgrade-response-user")
        registration = SingerRegistration.objects.create(
            activity=self.activity,
            user=user,
            name="Singer",
            student_id="UPGRADE-1",
            college="College",
            class_name="Class",
            phone="13800000000",
            song_name="Song",
            is_test_data=True,
        )
        QuestionnaireResponse.objects.create(
            singer_registration=registration,
            ruleset_version=self.version,
            questionnaire_key="singer_submission",
            subject=QuestionnaireResponse.Subject.PARTICIPANT,
            is_test_data=True,
        )

        with self.assertRaisesMessage(CommandError, "already has questionnaire responses"):
            self._run()
