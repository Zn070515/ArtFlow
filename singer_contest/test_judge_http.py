from django.test import SimpleTestCase
from django.urls import reverse


class JudgeRouteContractTests(SimpleTestCase):
    def test_judge_context_route_is_mounted(self):
        self.assertEqual(reverse("judge:context"), "/judge/context/")

    def test_judge_score_route_is_mounted(self):
        self.assertEqual(reverse("judge:score"), "/judge/score/")
