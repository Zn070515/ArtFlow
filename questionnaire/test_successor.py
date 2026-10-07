"""P9 — carrying answers across a questionnaire version, and refusing the redefinitions.

The case this exists for is ordinary: registration is open, ten people have filled their
details in, and staff realise a question is missing. Superseding the ruleset must not ask
all ten to start again. What carries is decided by the stable key, and by whether the
question still *means* the same thing.

Three rules:

- a key that exists on both sides with the same type, binding and file purpose carries its
  answer;
- a key that is new contributes nothing, and is simply missing;
- a key that changes meaning — ``file`` becoming ``text``, an accompaniment becoming a
  background video — is refused outright. Silently reusing the slot is how a participant's
  file ends up answering a question it was never uploaded for.
"""

import json
from uuid import uuid4

from accounts.models import User
from common.authority import ACCOUNT_AUTHORITY, authority_write
from common.test_characterization import _CharacterizationBase
from django.core.exceptions import ValidationError
from django.test import SimpleTestCase
from files.policies import file_purpose_policy
from ruleset.models import ContestRuleset, RulesetVersion
from ruleset.services import freeze_ruleset_version, supersede_ruleset_version
from singer_contest.models import ContestRound, RubricCriterion, ScoringRubric, SingerRegistration

from .compiler import compile_questionnaire
from .models import QuestionnaireResponse
from .registration import get_or_create_draft_registration
from .schema import schema_hash
from .services import save_draft_answers
from .successor import carry_answers, carry_over_keys, incompatible_keys, validate_successor


def _questionnaire(
    *, extra=None, song_type="text", purpose="accompaniment", key="singer_submission"
):
    file_policy = file_purpose_policy(purpose)
    questions = [
        {"key": "name", "type": "text", "label": "姓名", "binding": "registration.name"},
        {"key": "r1.song", "type": song_type, "label": "第一轮曲目", "round": "r1"},
        {
            "key": "r1.accompaniment",
            "type": "file",
            "label": "第一轮伴奏",
            "round": "r1",
            "file": {
                "purpose": purpose,
                "extensions": [sorted(file_policy.extensions)[0]],
                "max_mb": file_policy.max_mb,
                "max_files": 1,
            },
        },
    ]
    if extra:
        questions.append(extra)
    return {
        "schema_version": 1,
        "key": key,
        "pages": [
            {
                "key": "basic",
                "title": "基本信息",
                "sections": [{"key": "s", "title": "身份", "questions": questions}],
            }
        ],
    }


def _plan(**kwargs):
    return compile_questionnaire(_questionnaire(**kwargs))


class CarryOverRuleTests(SimpleTestCase):
    def test_an_unchanged_question_carries_its_answer(self):
        previous, current = _plan(), _plan()
        answers = {"name": "陈", "r1.song": "歌", "r9.gone": "旧"}
        self.assertEqual(carry_answers(previous, current, answers), {"name": "陈", "r1.song": "歌"})

    def test_a_new_question_contributes_nothing(self):
        previous = _plan()
        current = _plan(extra={"key": "r3.host_material", "type": "text", "label": "主持稿素材"})
        self.assertNotIn("r3.host_material", carry_over_keys(previous, current))
        self.assertEqual(carry_answers(previous, current, {"r3.host_material": "x"}), {})

    def test_a_removed_question_is_not_carried(self):
        previous = _plan(extra={"key": "old.foo", "type": "text", "label": "旧题"})
        current = _plan()
        self.assertEqual(carry_answers(previous, current, {"old.foo": "x"}), {})

    def test_changing_a_type_is_incompatible(self):
        self.assertEqual(incompatible_keys(_plan(), _plan(song_type="textarea")), ["r1.song"])

    def test_changing_a_binding_is_incompatible(self):
        previous = compile_questionnaire(_questionnaire())
        changed = _questionnaire()
        changed["pages"][0]["sections"][0]["questions"][0]["binding"] = "registration.phone"
        self.assertEqual(incompatible_keys(previous, compile_questionnaire(changed)), ["name"])

    def test_changing_a_file_purpose_is_incompatible(self):
        self.assertEqual(
            incompatible_keys(_plan(), _plan(purpose="background_video")), ["r1.accompaniment"]
        )

    def test_changing_choice_values_is_incompatible(self):
        first = _questionnaire(song_type="single_choice")
        current = _questionnaire(song_type="single_choice")
        for document, values in ((first, ("solo", "duet")), (current, ("solo", "chorus"))):
            song = document["pages"][0]["sections"][0]["questions"][1]
            song["options"] = [{"value": value, "label": value} for value in values]
        self.assertEqual(
            incompatible_keys(compile_questionnaire(first), compile_questionnaire(current)),
            ["r1.song"],
        )

    def test_changing_validation_domain_is_incompatible(self):
        first = _questionnaire()
        current = _questionnaire()
        first["pages"][0]["sections"][0]["questions"][1]["validation"] = {"max_length": 20}
        current["pages"][0]["sections"][0]["questions"][1]["validation"] = {"max_length": 40}
        self.assertEqual(
            incompatible_keys(compile_questionnaire(first), compile_questionnaire(current)),
            ["r1.song"],
        )

    def test_validate_successor_names_every_incompatible_key(self):
        with self.assertRaises(ValidationError) as caught:
            validate_successor(_plan(), _plan(song_type="textarea", purpose="background_video"))
        message = str(caught.exception)
        self.assertIn("r1.song", message)
        self.assertIn("r1.accompaniment", message)


class _SuccessorBase(_CharacterizationBase):
    def admin(self):
        cached = getattr(self, "_admin_user", None)
        if cached is not None:
            return cached
        user = self.make_user(f"succ-admin-{uuid4().hex[:8]}")
        user.role = User.Role.ADMIN
        with authority_write(ACCOUNT_AUTHORITY):
            user.save()
        self._admin_user = user
        return user

    def ruleset(self):
        activity = self.make_activity(is_test_mode=True, title=f"换版-{uuid4().hex[:6]}")
        ruleset = ContestRuleset.objects.create(activity=activity, name="RS", is_test_data=True)
        rubric = ScoringRubric.objects.create(activity=activity, name="r1评分", is_test_data=True)
        RubricCriterion.objects.create(rubric=rubric, name="总分", max_score=100, is_test_data=True)
        contest_round = ContestRound.objects.create(
            activity=activity, round_type=ContestRound.RoundType.PRELIMINARY, name="r1"
        )
        contest_round.rubric = rubric
        contest_round.save(update_fields=["rubric"])
        ruleset.round_keys = {"r1": contest_round.pk}
        ruleset.save(update_fields=["round_keys"])
        for i in range(3):
            self.make_singer(
                activity,
                username=f"succ-field-{activity.pk}-{i}",
                student_id=f"30{i:04d}",
                pre_status=SingerRegistration.PreStatus.APPROVED,
                is_test_data=True,
            )
        return ruleset

    def version(self, ruleset, questionnaire):
        root = {
            "schema_version": 1,
            "nodes": [
                {"key": "assess_r1", "type": "ASSESS", "source": "entry", "round": "r1"},
                {"key": "rank1", "type": "RANK", "source": "assess_r1", "descending": True},
                {"key": "top2", "type": "SELECT", "source": "rank1", "count": 2},
            ],
            "questionnaire": questionnaire,
        }
        return RulesetVersion.objects.create(
            ruleset=ruleset, definition=json.dumps(root, ensure_ascii=False)
        )


class SuccessorFreezeTests(_SuccessorBase):
    def test_freezing_a_successor_carries_answers_forward(self):
        ruleset = self.ruleset()
        first = self.version(ruleset, _questionnaire())
        freeze_ruleset_version(first, self.admin())
        first.refresh_from_db()

        participant = self.make_user(f"succ-singer-{uuid4().hex[:8]}")
        registration, response = get_or_create_draft_registration(version=first, user=participant)
        save_draft_answers(response, answers={"r1.song": "美丽的神话"})

        successor = supersede_ruleset_version(first, created_by=self.admin())
        successor.definition = json.dumps(
            {
                **json.loads(successor.definition),
                "questionnaire": _questionnaire(
                    extra={"key": "r3.host_material", "type": "text", "label": "主持稿素材"}
                ),
            },
            ensure_ascii=False,
        )
        successor.save(update_fields=["definition"])
        freeze_ruleset_version(successor, self.admin())

        carried = QuestionnaireResponse.objects.get(
            singer_registration=registration, ruleset_version=successor
        )
        self.assertEqual(carried.answers.get("r1.song"), "美丽的神话")
        self.assertNotIn("name", carried.answers)
        self.assertEqual(
            carried.schema_hash,
            schema_hash(
                _questionnaire(
                    extra={"key": "r3.host_material", "type": "text", "label": "主持稿素材"}
                )
            ),
        )

    def test_a_question_added_by_a_successor_gets_a_material_check(self):
        """The new question has to be answerable, not merely carried.

        The per-question checks are created on the form's first open, which for this
        participant already happened, so a successor's new question arrived with no check:
        `writable_question_keys` offered nothing, staff had no check to send back, and once
        registration closed that participant could never answer a question they had never
        been asked.
        """
        from files.models import MaterialCheck

        ruleset = self.ruleset()
        first = self.version(ruleset, _questionnaire())
        freeze_ruleset_version(first, self.admin())
        first.refresh_from_db()
        participant = self.make_user(f"succ-check-{uuid4().hex[:8]}")
        registration, _response = get_or_create_draft_registration(version=first, user=participant)
        self.assertFalse(
            MaterialCheck.objects.filter(
                singer_registration=registration, question_key="r3.host_material"
            ).exists()
        )

        successor = supersede_ruleset_version(first, created_by=self.admin())
        successor.definition = json.dumps(
            {
                **json.loads(successor.definition),
                "questionnaire": _questionnaire(
                    extra={"key": "r3.host_material", "type": "text", "label": "主持稿素材"}
                ),
            },
            ensure_ascii=False,
        )
        successor.save(update_fields=["definition"])
        freeze_ruleset_version(successor, self.admin())

        self.assertTrue(
            MaterialCheck.objects.filter(
                singer_registration=registration, question_key="r3.host_material"
            ).exists()
        )

    def test_a_new_question_is_simply_missing_in_the_successor(self):
        ruleset = self.ruleset()
        first = self.version(ruleset, _questionnaire())
        freeze_ruleset_version(first, self.admin())
        first.refresh_from_db()
        participant = self.make_user(f"succ-singer-{uuid4().hex[:8]}")
        registration, _response = get_or_create_draft_registration(version=first, user=participant)

        successor = supersede_ruleset_version(first, created_by=self.admin())
        extra = {"key": "r3.host_material", "type": "text", "label": "主持稿素材"}
        successor.definition = json.dumps(
            {**json.loads(successor.definition), "questionnaire": _questionnaire(extra=extra)},
            ensure_ascii=False,
        )
        successor.save(update_fields=["definition"])
        freeze_ruleset_version(successor, self.admin())

        carried = QuestionnaireResponse.objects.get(
            singer_registration=registration, ruleset_version=successor
        )
        self.assertNotIn("r3.host_material", carried.answers)

    def test_a_removed_question_leaves_the_historical_response_auditable(self):
        ruleset = self.ruleset()
        old = {"key": "old.foo", "type": "text", "label": "旧题"}
        first = self.version(ruleset, _questionnaire(extra=old))
        freeze_ruleset_version(first, self.admin())
        first.refresh_from_db()
        participant = self.make_user(f"succ-singer-{uuid4().hex[:8]}")
        registration, response = get_or_create_draft_registration(version=first, user=participant)
        save_draft_answers(response, answers={"old.foo": "曾经填过"})

        successor = supersede_ruleset_version(first, created_by=self.admin())
        successor.definition = json.dumps(
            {**json.loads(successor.definition), "questionnaire": _questionnaire()},
            ensure_ascii=False,
        )
        successor.save(update_fields=["definition"])
        freeze_ruleset_version(successor, self.admin())

        response.refresh_from_db()
        self.assertEqual(response.answers.get("old.foo"), "曾经填过")
        carried = QuestionnaireResponse.objects.get(
            singer_registration=registration, ruleset_version=successor
        )
        self.assertNotIn("old.foo", carried.answers)

    def test_freezing_a_successor_that_redefines_a_key_is_refused(self):
        ruleset = self.ruleset()
        first = self.version(ruleset, _questionnaire())
        freeze_ruleset_version(first, self.admin())
        first.refresh_from_db()

        successor = supersede_ruleset_version(first, created_by=self.admin())
        successor.definition = json.dumps(
            {
                **json.loads(successor.definition),
                "questionnaire": _questionnaire(song_type="textarea"),
            },
            ensure_ascii=False,
        )
        successor.save(update_fields=["definition"])
        with self.assertRaises(ValidationError) as caught:
            freeze_ruleset_version(successor, self.admin())
        self.assertIn("r1.song", str(caught.exception))


class SupersededPageTests(_SuccessorBase):
    def test_a_page_still_open_on_the_old_version_is_told_to_refresh(self):
        """The successor's schema hash differs, so an autosave from the old tab is a 409
        rather than a write into a questionnaire it cannot see."""
        ruleset = self.ruleset()
        first = self.version(ruleset, _questionnaire())
        freeze_ruleset_version(first, self.admin())
        first.refresh_from_db()
        participant = self.make_user(f"succ-singer-{uuid4().hex[:8]}")
        registration, response = get_or_create_draft_registration(version=first, user=participant)
        old_hash = response.schema_hash

        successor = supersede_ruleset_version(first, created_by=self.admin())
        extra = {"key": "r3.host_material", "type": "text", "label": "主持稿素材"}
        successor.definition = json.dumps(
            {**json.loads(successor.definition), "questionnaire": _questionnaire(extra=extra)},
            ensure_ascii=False,
        )
        successor.save(update_fields=["definition"])
        freeze_ruleset_version(successor, self.admin())

        self.assertNotEqual(schema_hash(_questionnaire(extra=extra)), old_hash)
        # The page is still on v1, so its next autosave arrives at the current version with
        # the hash it was rendered under — and is refused.
        from .registration import save_draft

        with self.assertRaises(ValidationError):
            save_draft(
                version=successor,
                registration=registration,
                answers={"r1.song": "改"},
                schema_hash=old_hash,
            )
