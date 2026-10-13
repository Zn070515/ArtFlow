import json

from accounts.models import User
from core.models import Activity
from django.test import TestCase
from django.urls import reverse
from ruleset.models import ContestRuleset, RulesetVersion
from ruleset.planning import planning_field
from ruleset.templates import golden_xiaofeng
from singer_contest.models import ContestRound

from staff_panel.tests import (
    _acceptance_definition_json,
    _create_activity,
    _create_provisioned_user,
)


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


class RulesetPlanningWorkflowTests(RulesetPlanningViewTests):
    def _planning_payload(self, *, complete=True):
        weight = (
            planning_field("40", "confirmed", "比赛方案", "percent")
            if complete
            else planning_field(None, "pending", "待确认", "percent")
        )
        return {
            "schema_version": 1,
            "stages": [
                {
                    "business_id": "stage-1",
                    "name": planning_field("初赛", "confirmed", "比赛方案", "text"),
                    "advance_count": planning_field(10, "confirmed", "比赛方案", "person"),
                    "result_method": planning_field("top_n", "confirmed", "比赛方案", "text"),
                    "judge_sources": [
                        {
                            "business_id": "round-1",
                            "round_key": "planning-r1",
                            "name": planning_field("第一轮", "confirmed", "比赛方案", "text"),
                            "weight": weight,
                        },
                        {
                            "business_id": "round-2",
                            "round_key": "planning-r2",
                            "name": planning_field("第二轮", "confirmed", "比赛方案", "text"),
                            "weight": planning_field("60", "confirmed", "比赛方案", "percent"),
                        },
                    ],
                    "audience_weight": planning_field("0", "confirmed", "无观众计分", "percent"),
                    "audience_source": planning_field("", "confirmed", "无观众计分", "vote"),
                }
            ],
            "execution_refs": {},
        }

    def test_preview_does_not_materialize_rounds_and_apply_keeps_two_rounds_in_one_stage(self):
        version = self._version()
        incomplete = self._planning_payload(complete=False)

        saved = self.client.post(
            reverse("staff:ruleset_planning", args=[version.pk]),
            data=json.dumps({"revision": 0, "payload": incomplete}),
            content_type="application/json",
        )
        self.assertEqual(saved.status_code, 200)
        self.assertEqual(ContestRound.objects.filter(activity=self.activity).count(), 0)

        preview = self.client.post(
            reverse("staff:ruleset_planning_preview", args=[version.pk]),
            data=json.dumps({"revision": 1, "payload": incomplete}),
            content_type="application/json",
        )
        self.assertEqual(preview.status_code, 200)
        self.assertFalse(preview.json()["result"]["can_apply"])
        self.assertEqual(ContestRound.objects.filter(activity=self.activity).count(), 0)

        complete = self._planning_payload()
        saved_complete = self.client.post(
            reverse("staff:ruleset_planning", args=[version.pk]),
            data=json.dumps({"revision": 1, "payload": complete}),
            content_type="application/json",
        )
        self.assertEqual(saved_complete.status_code, 200)
        applied = self.client.post(
            reverse("staff:ruleset_planning_apply", args=[version.pk]),
            data=json.dumps({"revision": 2, "payload": complete}),
            content_type="application/json",
        )

        self.assertEqual(applied.status_code, 200, applied.content)
        self.assertEqual(
            ContestRound.objects.filter(
                activity=self.activity, status=ContestRound.Status.DRAFT
            ).count(),
            2,
        )
        version.refresh_from_db()
        self.assertEqual(len(version.ruleset.round_keys or {}), 2)
        self.assertEqual(len(json.loads(version.definition)["checkpoints"]), 1)

    def test_complex_definition_is_read_only_in_the_ordinary_workbench(self):
        ruleset = ContestRuleset.objects.create(
            activity=self.activity,
            name="复杂历史规则",
            is_test_data=True,
            created_by=self.staff,
        )
        version = RulesetVersion.objects.create(
            ruleset=ruleset,
            definition=golden_xiaofeng(),
            created_by=self.staff,
        )

        response = self.client.get(reverse("staff:ruleset_planning", args=[version.pk]))

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.context["planning_read_only"])
        self.assertContains(response, "专业工具")
        self.assertContains(response, "只展示历史摘要")
