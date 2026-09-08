from unittest.mock import patch

from django.core.exceptions import ValidationError
from django.test import SimpleTestCase
from django.urls import reverse

from .judge_authority import JudgeContext


class JudgeRouteContractTests(SimpleTestCase):
    def test_judge_context_route_is_mounted(self):
        self.assertEqual(reverse("judge:context"), "/judge/context/")

    def test_judge_score_route_is_mounted(self):
        self.assertEqual(reverse("judge:score"), "/judge/score/")

    def test_context_rejects_missing_bearer_without_secret_detail(self):
        response = self.client.get(reverse("judge:context"))

        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.json()["reason_code"], "INVALID_JUDGE_SESSION")
        self.assertEqual(response["Cache-Control"], "no-store")

    @patch("singer_contest.judge_views.get_judge_context")
    def test_context_returns_server_owned_display_and_criterion_fields(self, context_mock):
        context_mock.return_value = JudgeContext(
            activity_id=1,
            round_id=2,
            round_name="决赛",
            seat_id=3,
            panel_snapshot_id=4,
            panel_version=1,
            context_version=5,
            performance_id=6,
            performance_label="第 6 个节目",
            singer_name="参赛者",
            song_title="曲目",
            performance_state="performing",
            rubric_payload={
                "name": "评分表",
                "criteria": [
                    {
                        "criterion_id": 12,
                        "name": "音准",
                        "description": "",
                        "max_score": "40.00",
                        "sequence": 1,
                    }
                ],
            },
        )

        response = self.client.get(
            reverse("judge:context"), HTTP_AUTHORIZATION="Bearer test-session"
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["context"]["round_name"], "决赛")
        self.assertEqual(
            response.json()["context"]["rubric_payload"]["criteria"][0]["criterion_id"],
            12,
        )
        self.assertEqual(response["Cache-Control"], "no-store")

    def test_score_rejects_cross_origin_before_reading_body(self):
        response = self.client.post(
            reverse("judge:score"),
            data="{}",
            content_type="application/json",
            HTTP_ORIGIN="https://evil.example",
        )

        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()["reason_code"], "ORIGIN_REJECTED")

    @patch("singer_contest.judge_views.submit_judge_score")
    def test_score_maps_rubric_payload_validation_to_stable_reason(self, submit_mock):
        submit_mock.side_effect = ValidationError("RUBRIC_PAYLOAD_INVALID")

        response = self.client.post(
            reverse("judge:score"),
            data={
                "command_id": "judge-http-rubric",
                "expected_context_version": 1,
                "expected_performance_id": 6,
                "score_payload": {"criteria": []},
            },
            content_type="application/json",
            HTTP_AUTHORIZATION="Bearer test-session",
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["reason_code"], "RUBRIC_PAYLOAD_INVALID")

    @patch("singer_contest.judge_views.allow")
    def test_score_has_a_shared_application_rate_limit_boundary(self, allow_mock):
        allow_mock.return_value.allowed = False
        allow_mock.return_value.retry_after_seconds = 17

        response = self.client.post(
            reverse("judge:score"), data="{}", content_type="application/json"
        )

        self.assertEqual(response.status_code, 429)
        self.assertEqual(response.json()["reason_code"], "RATE_LIMITED")
        self.assertEqual(response["Retry-After"], "17")
        allow_mock.assert_called_once()
