"""Regression tests for questionnaire-backed registration display projections."""

from types import SimpleNamespace

from django.test import SimpleTestCase

from .projection import generic_song_label, questionnaire_value


class QuestionnaireProjectionTests(SimpleTestCase):
    def test_current_questionnaire_is_never_collapsed_to_one_global_song(self):
        registration = SimpleNamespace(
            song_name="旧的单曲",
            _artflow_questionnaire_active=True,
            _artflow_questionnaire_answers={"r1.song": "第一轮", "r2.song": "第二轮"},
        )

        self.assertEqual(questionnaire_value(registration, "r2.song"), "第二轮")
        self.assertEqual(generic_song_label(registration), "多轮曲目")

    def test_legacy_registration_keeps_legacy_display_value(self):
        registration = SimpleNamespace(
            song_name="历史曲目",
            _artflow_questionnaire_active=False,
            _artflow_questionnaire_answers={},
        )

        self.assertEqual(generic_song_label(registration), "历史曲目")

