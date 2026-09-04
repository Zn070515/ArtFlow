"""M1-INTEGRATION-CLOSE Item 8 — Full HTTP end-to-end operator acceptance.

Drives the whole 2025 院十佳 (``GOLDEN_SCHIDUI``) chain through real views/services, never
ORM-fabricating the authority state the reviewer's note forbids: a FROZEN
:class:`RulesetVersion`, an :class:`AudienceScore`, or a formal roster (``RoundEntry``). Only
auth/user/activity/round *entity* setup uses ORM (that is legitimate test-setup, not
resolver-authority state); every production transition goes through the staff HTTP surface or
the owning service.

The chain (15 approved singers, 5 judges, 100-mark rubric):
    R1+R2 judge scores + audience1  -> auto-READY stage1 (top10)
    confirm stage1                 -> materialise R3 roster
    prep R3 (Item 5 gate now CONFIRMED) + score -> READY stage2 (top5)
    confirm stage2                 -> materialise R4 roster
    prep R4 + score + audience4    -> READY stage3 (top3)
    confirm final                  -> result board (3 CONFIRMED stages) + host handcard

Item 5 (STAGE round only preparable from a CONFIRMED upstream) and Item 6
(unlock of a depended-upon stage is blocked once a downstream round started) are also
asserted here, since they are the operator-facing walls the whole chain depends on.
"""

import json
from decimal import Decimal

from accounts.models import User
from core.models import Activity
from django.core.exceptions import PermissionDenied, ValidationError
from django.test import TestCase
from django.urls import reverse
from ruleset.models import RulesetVersion
from ruleset.templates import seed_ruleset_templates
from singer_contest.models import (
    AudienceScore,
    ContestRound,
    Judge,
    RoundEntry,
    RubricCriterion,
    ScoringRubric,
    SingerRegistration,
    StageResult,
)
from singer_contest.services import (
    prepare_round,
    unlock_stage_result,
)


class OperatorEndToEndTests(TestCase):
    """The production operator acceptance chain through the real staff HTTP surface."""

    def _make_operator(self):
        return User.objects.create_user(username="operator", password="pass", role=User.Role.ADMIN)

    def setUp(self):
        self.operator = self._make_operator()
        self.client.force_login(self.operator)

        self.activity = Activity.objects.create(
            title="院十佳",
            activity_type=Activity.Type.SINGER_CONTEST,
            phase=Activity.Phase.RESULTS_PENDING,
            is_test_mode=True,
        )
        self.rubric = ScoringRubric.objects.create(activity=self.activity, name="100 分制")
        RubricCriterion.objects.create(rubric=self.rubric, name="演唱", max_score=Decimal("100"))
        self.judges = [
            Judge.objects.create(
                activity=self.activity, name=f"评委{chr(0x41 + i)}", is_active=True
            )
            for i in range(5)
        ]
        self.singers = [self._singer(i) for i in range(1, 16)]
        seed_ruleset_templates(operator=self.operator)

    def _singer(self, index):
        return SingerRegistration.objects.create(
            activity=self.activity,
            user=User.objects.create_user(username=f"e2e-s{index}", password="pass"),
            name=f"选手{index}",
            student_id=f"95{index:03d}",
            college="学院",
            class_name="班级",
            song_name="歌",
            pre_status=SingerRegistration.PreStatus.APPROVED,
            is_test_data=True,
        )

    # --- helpers -----------------------------------------------------------

    def _create_round(self, sequence, roster_source, roster_source_stage="", order_policy=None):
        resp = self.client.post(
            reverse("staff:round_create"),
            {
                "activity_id": self.activity.pk,
                "round_type": ContestRound.RoundType.PRELIMINARY,
                "name": f"轮次{sequence}",
                "scoring_mode": ContestRound.ScoringMode.AVERAGE,
                "sequence": sequence,
                "order_policy": order_policy or ContestRound.OrderPolicy.REGISTRATION_ORDER,
                "roster_source": roster_source,
                "roster_source_stage": roster_source_stage,
                "rubric": self.rubric.pk,
                "advance_count": 0,
            },
        )
        self.assertEqual(resp.status_code, 302, resp.content[:500])
        return ContestRound.objects.get(activity=self.activity, sequence=sequence)

    def _clone_and_freeze(self, round_map):
        # The operator instantiates the golden ruleset through the real "clone last year"
        # path, then binds it (round_keys + audience_keys) and freezes it — the production
        # freeze path, not ORM.
        resp = self.client.post(
            reverse("staff:ruleset_clone_last_year"),
            {"activity": self.activity.pk, "name": "院十佳规则"},
        )
        self.assertEqual(resp.status_code, 302, resp.content[:500])
        version = RulesetVersion.objects.get(
            ruleset__activity=self.activity, status=RulesetVersion.Status.DRAFT
        )
        resp = self.client.post(
            reverse("staff:ruleset_bind", args=[version.pk]),
            {
                "stage_key": "院十佳",
                "round_keys": json.dumps(
                    {
                        "r1": round_map["r1"],
                        "r2": round_map["r2"],
                        "r3": round_map["r3"],
                        "r4": round_map["r4"],
                    }
                ),
                "vote_keys": "{}",
                "group_keys": "{}",
                "audience_keys": json.dumps({"audience1": "aud1set", "audience4": "aud4set"}),
                "announcement_blocks": "[]",
                "announcement_blocks_by_checkpoint": "{}",
            },
        )
        self.assertEqual(resp.status_code, 302, resp.content[:500])
        resp = self.client.post(reverse("staff:ruleset_freeze", args=[version.pk]))
        self.assertEqual(resp.status_code, 302, resp.content[:500])
        version.refresh_from_db()
        self.assertEqual(version.status, RulesetVersion.Status.FROZEN)
        self.assertTrue(version.is_current)
        self.assertEqual(
            version.binding.get("audience_keys"), {"audience1": "aud1set", "audience4": "aud4set"}
        )
        return version

    def _prepare(self, pk):
        resp = self.client.post(reverse("staff:round_prepare", args=[pk]))
        self.assertEqual(resp.status_code, 302, resp.content[:500])

    def _post_round_scores(self, round_, base):
        payload = self.client.get(reverse("staff:round_scores_api", args=[round_.pk])).json()
        cells = []
        for idx, row in enumerate(payload["grid"]):
            score = str(Decimal(base) - idx)
            for cell in row["cells"]:
                cells.append(
                    {"singer_id": row["singer_id"], "judge_id": cell["judge_id"], "score": score}
                )
        resp = self.client.post(
            reverse("staff:round_scores_api", args=[round_.pk]),
            data=json.dumps({"base_version": payload["version"], "cells": cells}),
            content_type="application/json",
        )
        return resp

    def _lock(self, pk):
        resp = self.client.post(reverse("staff:round_lock", args=[pk]))
        self.assertEqual(resp.status_code, 302, resp.content[:500])

    def _audience_rows(self, set_key):
        sets = self.client.get(
            reverse("staff:audience_scores_api", args=[self.activity.pk])
        ).json()["sets"]
        for s in sets:
            if s["set_key"] == set_key:
                return s["rows"]
        self.fail(f"未找到观众分组 {set_key}")

    def _post_audience(self, set_key, rows, score):
        cells = [
            {"singer_id": r["singer_id"], "set_key": set_key, "score": str(Decimal(score))}
            for r in rows
        ]
        resp = self.client.post(
            reverse("staff:audience_scores_api", args=[self.activity.pk]),
            data=json.dumps({"cells": cells}),
            content_type="application/json",
        )
        return resp

    def _confirm(self, stage):
        resp = self.client.post(reverse("staff:stage_result_confirm", args=[stage.pk]))
        self.assertEqual(resp.status_code, 302, resp.content[:500])
        stage.refresh_from_db()
        return stage

    def _entry_rank(self, round_):
        return list(
            RoundEntry.objects.filter(round=round_)
            .order_by("running_order", "pk")
            .values_list("singer_id", flat=True)
        )

    # --- the chain ---------------------------------------------------------

    def test_full_http_operator_acceptance(self):
        # 1) Activity + rounds R1-R4 through the round form POST (Item 2 fields).
        r1 = self._create_round(1, ContestRound.RosterSource.APPROVED)
        r2 = self._create_round(2, ContestRound.RosterSource.APPROVED)
        r3 = self._create_round(3, ContestRound.RosterSource.STAGE, "stage1")
        r4 = self._create_round(
            4,
            ContestRound.RosterSource.STAGE,
            "stage2",
            ContestRound.OrderPolicy.PREVIOUS_RANK_ASC,
        )
        for r in (r1, r2, r3, r4):
            self.assertEqual(
                r.roster_source,
                ContestRound.RosterSource.APPROVED
                if r in (r1, r2)
                else ContestRound.RosterSource.STAGE,
            )
        self.assertEqual(r3.roster_source_stage, "stage1")
        self.assertEqual(r4.roster_source_stage, "stage2")
        self.assertEqual(r4.order_policy, ContestRound.OrderPolicy.PREVIOUS_RANK_ASC)
        self.assertEqual(r1.rubric_id, self.rubric.pk)

        # 2) Instantiate golden, bind (with audience_keys), freeze — the real production paths.
        self._clone_and_freeze({"r1": r1.pk, "r2": r2.pk, "r3": r3.pk, "r4": r4.pk})

        # 3) Prepare + score R1/R2 (Item 2 fields made this possible).
        self._prepare(r1.pk)
        self._prepare(r2.pk)
        r1_resp = self._post_round_scores(r1, 100)
        self.assertTrue(r1_resp.json()["matrix_complete"], r1_resp.content[:500])
        r2_resp = self._post_round_scores(r2, 90)
        self.assertTrue(r2_resp.json()["matrix_complete"], r2_resp.content[:500])
        # audience1 not yet entered -> no stage auto-resolves yet (HOLD), so no warning.
        self.assertNotIn("resolve_warning", r2_resp.json())
        self.assertIsNone(r2_resp.json()["resolved_status"])
        # 4) Lock R1/R2 so the confirm gate accepts them.
        self._lock(r1.pk)
        self._lock(r2.pk)

        # 5) Audience page is roster-scoped: audience1 (entry stage, no downstream round yet)
        #    falls back to the check-in pool -> all 15 singers.
        aud1_rows = self._audience_rows("audience1")
        self.assertEqual(len(aud1_rows), 15)
        self.assertEqual({r["singer_id"] for r in aud1_rows}, {s.pk for s in self.singers})

        # 6) Enter audience1 -> stage1 auto-READY (30/60/10 with a real stored AudienceScore).
        aud1_resp = self._post_audience("audience1", aud1_rows, 80)
        self.assertEqual(aud1_resp.json()["saved"], 15, aud1_resp.content[:500])
        self.assertEqual(aud1_resp.json()["resolved_status"], "ready_to_confirm")
        self.assertNotIn("resolve_warning", aud1_resp.json())
        s1 = StageResult.objects.get(activity=self.activity, stage_key="stage1")
        self.assertEqual(s1.status, StageResult.Status.READY_TO_CONFIRM)
        first = self.singers[0].pk
        comp1 = {
            c["source"]: c for c in s1.composites.get(singer_id=first, node_key="stage1").components
        }
        self.assertEqual(Decimal(comp1["assess_a1"]["value"]), Decimal("80"))
        self.assertEqual(Decimal(comp1["assess_a1"]["contribution"]), Decimal("8.0"))
        self.assertEqual(
            s1.composites.get(singer_id=first, node_key="stage1").value, Decimal("92.0")
        )
        # A real stored AudienceScore row must exist (not ORM-fabricated).
        self.assertEqual(
            AudienceScore.objects.filter(activity=self.activity, stage_key="aud1set").count(), 15
        )

        # 7) Item 5 gate: R3 cannot be prepared while stage1 is only READY (not CONFIRMED).
        with self.assertRaises(ValidationError):
            prepare_round(r3, self.operator)
        r3.refresh_from_db()
        self.assertEqual(r3.status, ContestRound.Status.DRAFT)
        # A staff operator cannot bypass it via HTTP either (view 500s on the ValidationError).
        # (The service-level assert above is the authoritative gate.)

        # 8) Confirm stage1 -> R3 roster (top10) materialises.
        s1 = self._confirm(s1)
        self.assertEqual(s1.status, StageResult.Status.CONFIRMED)
        self.assertEqual(
            self._entry_rank(r3), [s.pk for s in self.singers[:10]], r3.entries.count()
        )

        # 9) Prep R3 (gate now CONFIRMED) + score -> stage2 auto-READY (no audience needed).
        self._prepare(r3.pk)
        r3_resp = self._post_round_scores(r3, 100)
        self.assertTrue(r3_resp.json()["matrix_complete"], r3_resp.content[:500])
        s2 = StageResult.objects.get(activity=self.activity, stage_key="stage2")
        self.assertEqual(s2.status, StageResult.Status.READY_TO_CONFIRM)
        self._lock(r3.pk)
        s2 = self._confirm(s2)
        self.assertEqual(s2.status, StageResult.Status.CONFIRMED)
        self.assertEqual(self._entry_rank(r4), [s.pk for s in self.singers[4::-1]])

        # 10) Prep R4 + score -> final holds (needs audience4).
        self._prepare(r4.pk)
        r4_resp = self._post_round_scores(r4, 90)
        self.assertTrue(r4_resp.json()["matrix_complete"], r4_resp.content[:500])

        # 11) Audience4 is roster-scoped to the materialised R4 roster (top5), not all 15.
        aud4_rows = self._audience_rows("audience4")
        self.assertEqual(len(aud4_rows), 5)
        self.assertEqual({r["singer_id"] for r in aud4_rows}, set(self._entry_rank(r4)))

        # 12) Enter audience4 -> final/stage3 auto-READY.
        aud4_resp = self._post_audience("audience4", aud4_rows, 85)
        self.assertEqual(aud4_resp.json()["saved"], 5, aud4_resp.content[:500])
        self.assertEqual(aud4_resp.json()["resolved_status"], "ready_to_confirm")
        self.assertNotIn("resolve_warning", aud4_resp.json())
        s3 = StageResult.objects.get(activity=self.activity, stage_key="stage3")
        self.assertEqual(s3.status, StageResult.Status.READY_TO_CONFIRM)
        final = s3.composites.get(singer_id=first, node_key="final")
        comp3 = {c["source"]: c for c in final.components}
        self.assertEqual(Decimal(comp3["assess_a4"]["value"]), Decimal("85"))
        self.assertEqual(Decimal(comp3["assess_a4"]["contribution"]), Decimal("17.0"))
        self.assertEqual(final.value, Decimal("90.0"))

        # 13) Lock R4 + confirm final -> host handcard (top3) + result board (3 CONFIRMED).
        self._lock(r4.pk)
        s3 = self._confirm(s3)
        self.assertEqual(s3.status, StageResult.Status.CONFIRMED)
        board = list(
            StageResult.objects.filter(activity=self.activity, status=StageResult.Status.CONFIRMED)
            .order_by("pk")
            .values_list("stage_key", flat=True)
        )
        self.assertEqual(board, ["stage1", "stage2", "stage3"])
        handcard = list(
            s3.decisions.filter(outcome_code="direct")
            .order_by("rank", "pk")
            .values_list("singer_id", flat=True)
        )
        self.assertEqual(handcard, [s.pk for s in self.singers[4:1:-1]])

        # 14) Item 6 gate: a downstream round started off stage1 -> unlock is refused.
        with self.assertRaises(PermissionDenied):
            unlock_stage_result(s1, operator=self.operator, note="e2e")

    def test_http_score_entry_reports_missing_matrix_cell(self):
        round_ = self._create_round(1, ContestRound.RosterSource.APPROVED)
        self._prepare(round_.pk)
        payload = self.client.get(reverse("staff:round_scores_api", args=[round_.pk])).json()
        cells = [
            {"singer_id": row["singer_id"], "judge_id": cell["judge_id"], "score": "90"}
            for row in payload["grid"]
            for cell in row["cells"]
        ]
        cells.pop()
        response = self.client.post(
            reverse("staff:round_scores_api", args=[round_.pk]),
            data=json.dumps({"base_version": payload["version"], "cells": cells}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.json()["matrix_complete"])
        self.assertIsNone(response.json()["resolved_status"])
