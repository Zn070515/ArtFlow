import json

from django.test import TestCase
from django.urls import reverse

from accounts.models import User
from core.models import Activity
from ruleset.models import ContestRuleset, RulesetVersion
from staff_panel.tests import _acceptance_definition_json, _create_activity, _create_provisioned_user


class RulesetPlanningViewTests(TestCase):
    def setUp(self):
        self.staff = _create_provisioned_user(
            username="planning-staff",
            password="pass",
            role=User.Role.STAFF,
        )
        self.activity = _create_activity(
            title="院十佳规划测试",
            activity_type=Activity.Type.SINGER_CONTEST,
            phase=Activity.Phase.REGISTRATION_OPEN,
            is_test_mode=True,
        )
        self.client.force_login(self.staff)

    def _version(self):
        ruleset = ContestRuleset.objects.create(
            activity=self.activity,
            name="规划测试赛制",
            is_test_data=True,
            created_by=self.staff,
        )
        return RulesetVersion.objects.create(
            ruleset=ruleset,
            definition=_acceptance_definition_json(),
            created_by=self.staff,
        )

    def test_create_route_enters_planning_workbench(self):
        response = self.client.post(
            reverse("staff:contest_ruleset_create"),
            {"activity": self.activity.pk, "name": "新比赛"},
        )

        version = RulesetVersion.objects.get(ruleset__activity=self.activity)
        self.assertRedirects(response, reverse("staff:ruleset_planning", args=[version.pk]))

    def test_planning_page_uses_business_language(self):
        version = self._version()

        response = self.client.get(reverse("staff:ruleset_planning", args=[version.pk]))

        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "比赛流程")
        self.assertContains(response, "成绩与晋级")
        self.assertNotContains(response, "RulesetVersion")
        self.assertNotContains(response, "content_hash")
        self.assertNotContains(response, "binding_signature")

    def test_invalid_planning_save_returns_raw_input_and_business_error(self):
        version = self._version()
        payload = {
            "schema_version": 1,
            "stages": [
                {
                    "business_id": "stage-1",
                    "name": "初赛",
                    "advance_count": 10,
                    "result_method": "top_n",
                    "judge_sources": [{"business_id": "round-1", "name": "初赛", "weight": "bad%"}],
                    "audience_weight": "0%",
                }
            ],
            "execution_refs": {},
        }

        response = self.client.post(
            reverse("staff:ruleset_planning", args=[version.pk]),
            data=json.dumps({"revision": 0, "payload": payload}),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 400)
        self.assertContains(response, "bad%", status_code=400)
        self.assertContains(response, "百分比格式", status_code=400)
