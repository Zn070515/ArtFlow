"""P11 — the private rehearsal fixture fills the questionnaire, not a single song column.

The fixture used to write each participant's round-one group song into
``SingerRegistration.song_name`` because that column was the only place a song could go.
It is not any more, and the rehearsal should exercise the flow the contestants actually
use: a draft opens, the answers go in, the participant submits, staff approve. Approving a
draft would put somebody in the roster who never finished their form, which is the one
thing the roster is supposed to mean.

What this file can prove on its own: the 2025 questionnaire compiles, a reference row maps
to four distinct rounds' songs, filling submits and approves, and all four songs are
readable at once afterwards. What it cannot prove here: the package-level orchestration in
``apply_private_fixture``, which needs the private fixture package to run at all.
"""

import json
from uuid import uuid4

from accounts.models import User
from core.models import Activity
from django.test import SimpleTestCase
from ruleset.models import ContestRuleset, RulesetVersion
from ruleset.services import freeze_ruleset_version
from singer_contest.models import (
    ContestRound,
    RubricCriterion,
    ScoringRubric,
    SingerRegistration,
)

from common.authority import ACCOUNT_AUTHORITY, authority_write
from common.test_characterization import _CharacterizationBase

from .private_test_loader import PrivateTestLoadError
from .private_test_questionnaire import (
    ACCOMPANIMENT_QUESTIONS,
    answers_from_reference_row,
    check_answers_landed,
    fill_registrations,
    historical_2025_questionnaire,
)

ROW = {
    "legacy_code": "A1",
    "round1_group_song": "第一轮合唱曲",
    "round2_song": "第二轮独唱曲",
    "actual_round3_song": "第三轮合作曲",
    "actual_final_song_raw": "第四轮决赛曲",
    "r4_guest_song": "嘉宾甲",
}


class HistoricalQuestionnaireTests(SimpleTestCase):
    def test_it_compiles(self):
        from questionnaire.compiler import compile_questionnaire

        plan = compile_questionnaire(historical_2025_questionnaire())
        self.assertEqual(plan.key, "singer_submission")

    def test_every_round_has_a_song_and_an_accompaniment(self):
        from questionnaire.compiler import compile_questionnaire

        plan = compile_questionnaire(historical_2025_questionnaire())
        for round_key in ("r1", "r2", "r3", "r4"):
            with self.subTest(round=round_key):
                self.assertIsNotNone(plan.question(f"{round_key}.song"))
                self.assertIsNotNone(plan.question(f"{round_key}.accompaniment"))
        self.assertEqual(tuple(q["key"] for q in plan.file_questions), ACCOMPANIMENT_QUESTIONS)

    def test_the_third_round_carries_the_guest_singer(self):
        from questionnaire.compiler import compile_questionnaire

        plan = compile_questionnaire(historical_2025_questionnaire())
        self.assertIsNotNone(plan.question("r3.guest_name"))

    def test_identity_binds_to_the_registration(self):
        from questionnaire.compiler import compile_questionnaire

        plan = compile_questionnaire(historical_2025_questionnaire())
        self.assertEqual(plan.bindings["registration.name"], "name")
        self.assertEqual(plan.bindings["registration.student_id"], "student_id")


class ReferenceRowTests(SimpleTestCase):
    def test_a_row_maps_to_the_four_rounds_songs(self):
        answers = answers_from_reference_row(ROW)
        self.assertEqual(
            answers,
            {
                "r1.song": "第一轮合唱曲",
                "r2.song": "第二轮独唱曲",
                "r3.song": "第三轮合作曲",
                "r4.song": "第四轮决赛曲",
                "r3.guest_name": "嘉宾甲",
            },
        )

    def test_a_row_without_songs_is_refused(self):
        self.assertEqual(answers_from_reference_row({"legacy_code": "X"}), {})

    def test_blank_fields_are_skipped_rather_than_written_empty(self):
        answers = answers_from_reference_row({**ROW, "round2_song": "   "})
        self.assertNotIn("r2.song", answers)


class FillRegistrationTests(_CharacterizationBase):
    def operator(self):
        cached = getattr(self, "_operator_user", None)
        if cached is not None:
            return cached
        user = self.make_user(f"priv-admin-{uuid4().hex[:8]}")
        user.role = User.Role.ADMIN
        with authority_write(ACCOUNT_AUTHORITY):
            user.save()
        self._operator_user = user
        return user

    def frozen_version(self):
        activity = self.make_activity(
            is_test_mode=True, phase=Activity.Phase.TESTING, title=f"priv-{uuid4().hex[:6]}"
        )
        ruleset = ContestRuleset.objects.create(activity=activity, name="RS", is_test_data=True)
        binding = {}
        for key in ("r1", "r2", "r3", "r4"):
            rubric = ScoringRubric.objects.create(
                activity=activity, name=f"{key}评分", is_test_data=True
            )
            RubricCriterion.objects.create(
                rubric=rubric, name="总分", max_score=100, is_test_data=True
            )
            contest_round = ContestRound.objects.create(
                activity=activity, round_type=ContestRound.RoundType.PRELIMINARY, name=key
            )
            contest_round.rubric = rubric
            contest_round.save(update_fields=["rubric"])
            binding[key] = contest_round.pk
        ruleset.round_keys = binding
        ruleset.save(update_fields=["round_keys"])
        definition = {
            "schema_version": 1,
            "nodes": [{"key": "assess_r1", "type": "ASSESS", "source": "entry", "round": "r1"}],
            "questionnaire": historical_2025_questionnaire(),
        }
        version = RulesetVersion.objects.create(
            ruleset=ruleset, definition=json.dumps(definition, ensure_ascii=False)
        )
        freeze_ruleset_version(version, self.operator())
        version.refresh_from_db()
        return version

    def participants(self, version, count=3):
        return [
            self.make_singer(
                version.ruleset.activity,
                username=f"priv-singer-{version.pk}-{i}",
                student_id=f"20{i:04d}",
                is_test_data=True,
            )
            for i in range(count)
        ]

    def test_filling_submits_and_approves(self):
        version = self.frozen_version()
        registrations = {f"C{i}": reg for i, reg in enumerate(self.participants(version))}
        reference = {f"C{i}": {**ROW, "legacy_code": f"C{i}"} for i in range(len(registrations))}
        responses = fill_registrations(
            version=version,
            registrations=registrations,
            reference_by_code=reference,
            operator=self.operator(),
        )
        for registration in registrations.values():
            registration.refresh_from_db()
            self.assertEqual(registration.pre_status, SingerRegistration.PreStatus.APPROVED)
        for response in responses.values():
            self.assertEqual(response.status, "submitted")

    def test_a_row_with_no_answers_stops_the_load_rather_than_approving_a_blank_draft(self):
        """Approval is the roster's meaning; it may not be granted to an unfilled form."""
        version = self.frozen_version()
        registrations = {"C0": self.participants(version, 1)[0]}
        with self.assertRaises(PrivateTestLoadError):
            fill_registrations(
                version=version,
                registrations=registrations,
                reference_by_code={"C0": {"legacy_code": "C0"}},
                operator=self.operator(),
            )
        registrations["C0"].refresh_from_db()
        self.assertEqual(registrations["C0"].pre_status, SingerRegistration.PreStatus.DRAFT)

    def test_all_four_rounds_songs_coexist_afterwards(self):
        version = self.frozen_version()
        registrations = {f"C{i}": reg for i, reg in enumerate(self.participants(version))}
        reference = {f"C{i}": {**ROW, "legacy_code": f"C{i}"} for i in range(len(registrations))}
        responses = fill_registrations(
            version=version,
            registrations=registrations,
            reference_by_code=reference,
            operator=self.operator(),
        )
        check_answers_landed(responses=responses, registrations=registrations)
