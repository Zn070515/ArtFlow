"""P3 — storing answers, and only for the version they were given under.

A ``QuestionnaireResponse`` is scoped to one registration, one FROZEN ruleset version, and
one questionnaire key. The version is part of the identity because the questionnaire is
part of that version's authority: an answer given under v1 is not an answer under v2, and
a successor version carries answers forward by ``question_key`` deliberately (P9), not by
letting one row serve both.

``answers`` holds only the *unbound* answers. Identity fields bound to the registration
and files bound to a ``question_key`` are read from where they already live, so there is
never a second copy to keep in step.
"""

import json

from common.test_characterization import _CharacterizationBase
from django.db import IntegrityError, transaction
from ruleset.models import ContestRuleset, RulesetVersion
from singer_contest.models import SingerRegistration

from .models import QuestionnaireResponse
from .services import get_or_create_response, mark_submitted, save_draft_answers

DEFINITION = json.dumps(
    {
        "schema_version": 1,
        "nodes": [{"key": "assess_r1", "type": "ASSESS", "source": "entry", "round": "r1"}],
    }
)


class _ResponseBase(_CharacterizationBase):
    def registration(self, activity, index=1):
        return self.make_singer(
            activity,
            username=f"resp-singer-{activity.pk}-{index}",
            student_id=f"80{index:04d}",
            pre_status=SingerRegistration.PreStatus.APPROVED,
            is_test_data=True,
        )

    def version(self, activity, version_number=1):
        # §16: one activity owns exactly one ContestRuleset; versions hold the history.
        ruleset, _created = ContestRuleset.objects.get_or_create(
            activity=activity, defaults={"name": "RS", "is_test_data": True}
        )
        return RulesetVersion.objects.create(
            ruleset=ruleset, version=version_number, definition=DEFINITION, is_current=False
        )


class QuestionnaireResponseModelTests(_ResponseBase):
    def test_a_new_response_is_a_draft_with_no_answers(self):
        activity = self.make_activity(is_test_mode=True)
        response = get_or_create_response(
            registration=self.registration(activity),
            ruleset_version=self.version(activity),
            questionnaire_key="singer_submission",
        )
        self.assertEqual(response.status, QuestionnaireResponse.Status.DRAFT)
        self.assertEqual(response.answers, {})
        self.assertIsNone(response.submitted_at)

    def test_get_or_create_is_idempotent_per_registration_version_and_key(self):
        activity = self.make_activity(is_test_mode=True)
        registration = self.registration(activity)
        version = self.version(activity)
        first = get_or_create_response(
            registration=registration, ruleset_version=version, questionnaire_key="q"
        )
        second = get_or_create_response(
            registration=registration, ruleset_version=version, questionnaire_key="q"
        )
        self.assertEqual(first.pk, second.pk)
        self.assertEqual(QuestionnaireResponse.objects.count(), 1)

    def test_the_same_registration_version_and_key_cannot_be_stored_twice(self):
        activity = self.make_activity(is_test_mode=True)
        registration = self.registration(activity)
        version = self.version(activity)
        QuestionnaireResponse.objects.create(
            singer_registration=registration, ruleset_version=version, questionnaire_key="q"
        )
        with self.assertRaises(IntegrityError):
            with transaction.atomic():
                QuestionnaireResponse.objects.create(
                    singer_registration=registration,
                    ruleset_version=version,
                    questionnaire_key="q",
                )

    def test_two_registrations_may_answer_the_same_questionnaire(self):
        activity = self.make_activity(is_test_mode=True)
        version = self.version(activity)
        for index in (1, 2):
            get_or_create_response(
                registration=self.registration(activity, index),
                ruleset_version=version,
                questionnaire_key="q",
            )
        self.assertEqual(QuestionnaireResponse.objects.count(), 2)

    def test_a_new_version_gets_its_own_response(self):
        """Carrying v1's answers into v2 is a deliberate migration step (P9), not an
        accident of sharing one row."""
        activity = self.make_activity(is_test_mode=True)
        registration = self.registration(activity)
        v1 = get_or_create_response(
            registration=registration,
            ruleset_version=self.version(activity, 1),
            questionnaire_key="q",
        )
        v2 = get_or_create_response(
            registration=registration,
            ruleset_version=self.version(activity, 2),
            questionnaire_key="q",
        )
        self.assertNotEqual(v1.pk, v2.pk)


class QuestionnaireResponseDraftTests(_ResponseBase):
    def _response(self, **kwargs):
        activity = self.make_activity(is_test_mode=True)
        return get_or_create_response(
            registration=self.registration(activity),
            ruleset_version=self.version(activity),
            questionnaire_key="q",
            **kwargs,
        )

    def test_saving_a_draft_merges_into_the_stored_answers(self):
        response = self._response()
        save_draft_answers(response, answers={"r1.song": "歌"})
        save_draft_answers(response, answers={"r2.song": "另一首"})
        response.refresh_from_db()
        self.assertEqual(response.answers, {"r1.song": "歌", "r2.song": "另一首"})

    def test_a_draft_save_records_the_schema_hash_it_was_written_against(self):
        response = self._response()
        save_draft_answers(response, answers={"r1.song": "歌"}, schema_hash="abc123")
        response.refresh_from_db()
        self.assertEqual(response.schema_hash, "abc123")

    def test_a_stale_schema_hash_is_refused(self):
        """A browser holding a form from before the questionnaire changed must be told to
        refresh rather than silently overwrite answers under a shape it does not know."""
        response = self._response(schema_hash="current")
        with self.assertRaises(Exception):
            save_draft_answers(response, answers={"r1.song": "歌"}, schema_hash="stale")
        response.refresh_from_db()
        self.assertEqual(response.answers, {})

    def test_submitting_does_not_by_itself_lock_the_response(self):
        """SUBMITTED records that a participant completed a formal submission; it is not a
        freeze on the row. Authority to write comes from the activity's phase and the staff
        supplement grants, which this low-level writer is deliberately not the decider of —
        making the status the gate locked people out of their own form the moment they
        submitted, while leaving their file uploads open."""
        response = self._response()
        save_draft_answers(response, answers={"r1.song": "歌"})
        mark_submitted(response)
        save_draft_answers(response, answers={"r1.song": "改"})
        response.refresh_from_db()
        self.assertEqual(response.answers, {"r1.song": "改"})
        self.assertEqual(response.status, QuestionnaireResponse.Status.SUBMITTED)

    def test_marking_submitted_stamps_the_time_and_status(self):
        response = self._response()
        mark_submitted(response)
        response.refresh_from_db()
        self.assertEqual(response.status, QuestionnaireResponse.Status.SUBMITTED)
        self.assertIsNotNone(response.submitted_at)

    def test_marking_submitted_twice_keeps_the_first_timestamp(self):
        response = self._response()
        mark_submitted(response)
        response.refresh_from_db()
        first = response.submitted_at
        mark_submitted(response)
        response.refresh_from_db()
        self.assertEqual(response.submitted_at, first)
