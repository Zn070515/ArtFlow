from unittest.mock import patch

from django.test import SimpleTestCase
from django.urls import reverse


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

    def test_score_rejects_cross_origin_before_reading_body(self):
        response = self.client.post(
            reverse("judge:score"),
            data="{}",
            content_type="application/json",
            HTTP_ORIGIN="https://evil.example",
        )

        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()["reason_code"], "ORIGIN_REJECTED")

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
