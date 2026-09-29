from types import SimpleNamespace

from django.test import SimpleTestCase

from staff_panel.forms import (
    RoundGroupsForm,
    RoundRunningOrderForm,
    ScoringRubricProvisionForm,
)


class StructuredOperatorFormTests(SimpleTestCase):
    def setUp(self):
        self.singers = [
            SimpleNamespace(pk=1, name="陈昭艺"),
            SimpleNamespace(pk=2, name="任在天"),
            SimpleNamespace(pk=3, name="冷沐阳"),
        ]

    def test_running_order_uses_visible_choices_and_returns_ordered_ids(self):
        form = RoundRunningOrderForm({"singer_ids": ["3", "1", "2"]}, singers=self.singers)
        self.assertTrue(form.is_valid(), form.errors)
        self.assertEqual(form.cleaned_data["singer_ids"], ["3", "1", "2"])
        self.assertNotIn("ID", form.fields["singer_ids"].help_text or "")

    def test_groups_normalize_repeated_fields_without_json(self):
        form = RoundGroupsForm(
            {
                "group_name_1": "A组",
                "group_singer_ids_1": ["1", "2"],
                "group_name_2": "B组",
                "group_singer_ids_2": ["3"],
            },
            singers=self.singers,
        )
        self.assertTrue(form.is_valid(), form.errors)
        self.assertEqual(
            form.cleaned_data["groups"],
            [
                {"name": "A组", "singer_ids": ["1", "2"]},
                {"name": "B组", "singer_ids": ["3"]},
            ],
        )

    def test_rubric_normalizes_repeated_criteria_without_json(self):
        form = ScoringRubricProvisionForm(
            {
                "name": "决赛评分",
                "criterion_name_1": "音准",
                "criterion_max_score_1": "40",
                "criterion_description_1": "音高与节奏",
                "criterion_name_2": "表现力",
                "criterion_max_score_2": "60",
            }
        )
        self.assertTrue(form.is_valid(), form.errors)
        self.assertEqual(form.cleaned_data["criteria"][0]["name"], "音准")
        self.assertEqual(form.cleaned_data["criteria"][1]["max_score"], 60)
