"""Positive PostgreSQL-sized acceptance path for the 2026 live format."""

import json
from decimal import Decimal
from typing import cast

from accounts.models import User
from common.authority import (
    ACCOUNT_AUTHORITY,
    ACTIVITY_STATE,
    CONTEST_ROUND_STATE,
    ROUND_PERFORMANCE_STATE,
    RULESET_FREEZE,
    SINGER_CONTESTANT_NUMBER,
    authority_write,
)
from core.models import Activity
from core.services import transition_activity_phase
from django.core.exceptions import ValidationError
from django.test import Client, TestCase
from django.urls import reverse
from ruleset.models import ContestRuleset, RulesetTemplate, RulesetVersion
from ruleset.services import _snapshot_binding, freeze_ruleset_version, update_ruleset_binding

from .challenge_services import (
    confirm_challenge_match_result,
    confirm_challenge_pairing,
    confirm_challenge_session,
    create_challenge_session,
    create_final_round_from_challenge,
    lock_challenge_match_scores,
    prepare_challenge_match,
    record_challenge_target,
    start_challenge_turn,
    waive_challenge_turn,
)
from .group_chorus import (
    confirm_group_stage,
    correct_group_stage,
    create_group_stage,
    freeze_group_stage,
    record_group_stage,
)
from .judge_authority import (
    advance_performance,
    lock_performance_score,
    prepare_judge_panel,
)
from .judge_entry import judge_entry_credential
from .models import (
    ContestRound,
    Judge,
    Performance,
    PerformanceGroup,
    PerformanceRunState,
    PerformanceScoreState,
    RubricCriterion,
    ScoreRecord,
    ScoreSummary,
    ScoringRubric,
    SingerRegistration,
)
from .podium_services import build_podium_result
from .services import apply_scores, lock_round, prepare_round, set_round_groups


def _live_questionnaire():
    questions = []
    for round_key, label in (("r2", "踢馆曲目"), ("r3", "第三轮曲目")):
        questions.extend(
            [
                {
                    "key": f"{round_key}.song",
                    "type": "text",
                    "label": label,
                    "round": round_key,
                    "required": True,
                },
                {
                    "key": f"{round_key}.accompaniment",
                    "type": "file",
                    "label": f"{label}伴奏",
                    "round": round_key,
                    "required": True,
                    "file": {
                        "purpose": "accompaniment",
                        "extensions": [".mp3"],
                        "max_mb": 100,
                    },
                },
            ]
        )
    return {
        "schema_version": 1,
        "key": "singer_submission",
        "pages": [
            {
                "key": "materials",
                "title": "现场材料",
                "sections": [{"key": "songs", "title": "歌曲", "questions": questions}],
            }
        ],
    }


class _Live2026AcceptanceFixtureMixin:
    """The complete 2026 acceptance fixture, sized by the class attributes below.

    The format's numbers are operator parameters, so a subclass moves them and re-runs the
    same end-to-end path.
    """

    PARTICIPANTS = 15
    SEATS = 10
    GROUP_COUNT = 5
    GROUP_SIZE = 3
    JUDGE_COUNT = 5
    #: The definition's qualifier SELECT. Defaults to the seat count; a subclass sets it to
    #: the built-in's shipped number to reproduce a ruleset whose definition has not caught
    #: up with an edited seat count yet.
    DEFINITION_SELECT_COUNT: int | None = None

    def setUp(self):
        with authority_write(ACCOUNT_AUTHORITY):
            self.admin = User.objects.create_user(
                username="live-2026-admin", password="pass", role=User.Role.ADMIN
            )
        with authority_write(ACTIVITY_STATE):
            self.activity = Activity.objects.create(
                title="2026 院十佳验收",
                activity_type=Activity.Type.SINGER_CONTEST,
                is_test_mode=True,
            )
        transition_activity_phase(self.activity, Activity.Phase.TESTING, actor=self.admin)

        self.judges = [
            Judge.objects.create(activity=self.activity, name=f"现场评委 {index}")
            for index in range(1, self.JUDGE_COUNT + 1)
        ]
        rubric = ScoringRubric.objects.create(
            activity=self.activity, name="2026 统一评分标准", is_test_data=True
        )
        self.criterion = RubricCriterion.objects.create(
            rubric=rubric, name="综合表现", max_score=100, is_test_data=True
        )
        with authority_write(CONTEST_ROUND_STATE):
            self.first_round = ContestRound.objects.create(
                activity=self.activity,
                round_type=ContestRound.RoundType.PRELIMINARY,
                name="第一轮",
                sequence=1,
                scoring_mode=ContestRound.ScoringMode.AVERAGE,
                score_completion_mode=ContestRound.CompletionMode.MINIMUM_VALID,
                judge_count=self.JUDGE_COUNT,
                minimum_judge_count=4,
                advance_count=self.SEATS,
                rubric=rubric,
            )

        self.singers = []
        for number in range(1, self.PARTICIPANTS + 1):
            with authority_write(ACCOUNT_AUTHORITY):
                user = User.objects.create_user(
                    username=f"live-2026-singer-{number}", password="pass"
                )
            singer = SingerRegistration.objects.create(
                activity=self.activity,
                user=user,
                name=f"选手 {number}",
                student_id=f"live-2026-{number:02d}",
                college="艺术学院",
                class_name="一班",
                phone=f"1390000{number:04d}",
                song_name=f"第一轮曲目 {number}",
                pre_status=SingerRegistration.PreStatus.APPROVED,
                is_test_data=True,
            )
            with authority_write(SINGER_CONTESTANT_NUMBER):
                singer.official_number = number
                singer.save(update_fields=["official_number", "updated_at"])
            self.singers.append(singer)

        self.group_specs = [
            {
                "name": f"第 {group_index} 组",
                "singer_ids": [
                    singer.pk for singer in self.singers[start : start + self.GROUP_SIZE]
                ],
            }
            for group_index, start in enumerate(
                range(0, self.PARTICIPANTS, self.GROUP_SIZE), start=1
            )
        ]
        self.group_stage = create_group_stage(
            self.activity,
            stage_key="r1_chorus",
            name="第一轮分组合唱",
            operator=self.admin,
        )
        record_group_stage(self.group_stage, self.group_specs, self.admin)
        confirm_group_stage(self.group_stage, self.admin)
        self.group_stage = freeze_group_stage(self.group_stage, self.admin)

        self.ruleset = ContestRuleset.objects.create(
            activity=self.activity,
            name="2026 院十佳现场赛制",
            is_test_data=True,
        )
        self.ruleset.round_keys = {"r1": self.first_round.pk}
        self.ruleset.group_stage_keys = {"r1": self.group_stage.pk}
        self.ruleset.live_challenge = {
            "format_key": "2026_live_challenge",
            "participant_count": self.PARTICIPANTS,
            "seat_count": self.SEATS,
            "challenge_count": self.PARTICIPANTS - self.SEATS,
            "group_count": self.GROUP_COUNT,
            "group_size": self.GROUP_SIZE,
            "first_round_weight": "40%",
            "challenge_round_weight": "60%",
            "order_policy": "official_number",
            "podium_stage_key": "final_podium",
            "podium_first_round_key": "r1",
            "podium_third_round_key": "r3",
            "podium_aggregate_node": "podium_total",
            "podium_first_round_weight": "30%",
            "podium_third_round_weight": "70%",
            "challenge_judge_ids": [judge.pk for judge in self.judges[:4]],
            "challenge_minimum_judge_count": 4,
            "final_judge_ids": [judge.pk for judge in self.judges[1:]],
            "final_minimum_judge_count": 4,
        }
        self.ruleset.save(update_fields=["round_keys", "group_stage_keys", "live_challenge"])
        definition = {
            "schema_version": 1,
            "nodes": [
                {"key": "assess_r1", "type": "ASSESS", "source": "entry", "round": "r1"},
                {"key": "rank1", "type": "RANK", "source": "assess_r1"},
                {
                    "key": "top10",
                    "type": "SELECT",
                    "source": "rank1",
                    "count": self.DEFINITION_SELECT_COUNT or self.SEATS,
                },
            ],
            "questionnaire": _live_questionnaire(),
        }
        with authority_write(RULESET_FREEZE):
            self.version = RulesetVersion.objects.create(
                ruleset=self.ruleset,
                version=1,
                definition=json.dumps(definition, ensure_ascii=False),
                created_by=self.admin,
            )

    def _score_performances(self, round_, scores, judges):
        prepare_judge_panel(round_.pk, operator=self.admin)
        for performance, score in zip(
            round_.performances.order_by("sequence", "pk"), scores, strict=True
        ):
            advance_performance(round_.pk, performance.pk, operator=self.admin)
            apply_scores(
                round_,
                {(performance.singer_id, judge.pk): score for judge in judges},
                self.admin,
            )
            run_state = PerformanceRunState.objects.get(round=round_.pk)
            lock_performance_score(
                round_.pk,
                performance.pk,
                operator=self.admin,
                expected_context_version=run_state.context_version,
            )

    def _score_challenge_match(self, session, match, challenger_score, defender_score, command):
        match = prepare_challenge_match(
            session.pk,
            operator=self.admin,
            command_id=f"{command}-prepare",
            expected_revision=match.session.revision,
        )
        score_round = match.score_round
        assert score_round is not None
        self.assertEqual(score_round.scoring_mode, ContestRound.ScoringMode.AVERAGE)
        self._score_performances(
            score_round,
            [challenger_score, defender_score],
            self.judges[:4],
        )
        match = lock_challenge_match_scores(
            session.pk,
            operator=self.admin,
            command_id=f"{command}-lock",
            expected_revision=match.session.revision,
        )
        return confirm_challenge_match_result(
            session.pk,
            operator=self.admin,
            command_id=f"{command}-confirm",
            expected_revision=match.session.revision,
        )


class Live2026AcceptanceTests(_Live2026AcceptanceFixtureMixin, TestCase):
    def test_freeze_dynamic_rounds_and_weighted_podium_without_audience(self):
        frozen = freeze_ruleset_version(self.version, self.admin)
        frozen.refresh_from_db()
        self.assertEqual(frozen.status, RulesetVersion.Status.FROZEN)
        self.assertEqual(frozen.binding["round_keys"], {"r1": self.first_round.pk})
        self.assertEqual(
            frozen.binding["live_challenge"]["scoring_standard"]["scoring_mode"], "average"
        )
        self.assertNotIn("r2", frozen.binding["round_keys"])
        self.assertNotIn("r3", frozen.binding["round_keys"])
        self.assertEqual(frozen.binding.get("vote_keys"), {})

        set_round_groups(self.first_round, self.group_specs, self.admin)
        prepared_first = prepare_round(self.first_round, self.admin)
        first_judges = list(
            prepared_first.round_judges.select_related("judge").values_list("judge", flat=True)
        )
        apply_scores(
            prepared_first,
            {
                (singer.pk, judge_id): Decimal(100 - singer.official_number)
                for singer in self.singers
                for judge_id in first_judges
            },
            self.admin,
        )
        lock_round(prepared_first, self.admin)
        self.first_round.refresh_from_db()
        self.assertEqual(
            set(
                ScoreSummary.objects.filter(round=self.first_round, is_advanced=True).values_list(
                    "singer_id", flat=True
                )
            ),
            {singer.pk for singer in self.singers[:10]},
        )

        session = create_challenge_session(
            self.first_round,
            ruleset_version=frozen,
            operator=self.admin,
            command_id="acceptance-create",
        )
        turn = start_challenge_turn(
            session.pk,
            operator=self.admin,
            command_id="acceptance-start-1",
            expected_revision=session.revision,
        )
        target = record_challenge_target(
            session.pk,
            seat_position=1,
            operator=self.admin,
            command_id="acceptance-target-1",
            expected_revision=turn.session.revision,
        )
        match = confirm_challenge_pairing(
            session.pk,
            operator=self.admin,
            command_id="acceptance-pair-1",
            expected_revision=target.session.revision,
        )
        first_match = self._score_challenge_match(session, match, 100, 80, "acceptance-match-1")
        self.assertEqual(first_match.winner_id, self.singers[14].pk)

        session.refresh_from_db()
        turn = start_challenge_turn(
            session.pk,
            operator=self.admin,
            command_id="acceptance-start-2",
            expected_revision=session.revision,
        )
        target = record_challenge_target(
            session.pk,
            seat_position=2,
            operator=self.admin,
            command_id="acceptance-target-2",
            expected_revision=turn.session.revision,
        )
        match = confirm_challenge_pairing(
            session.pk,
            operator=self.admin,
            command_id="acceptance-pair-2",
            expected_revision=target.session.revision,
        )
        second_match = self._score_challenge_match(session, match, 100, 80, "acceptance-match-2")
        self.assertEqual(second_match.winner_id, self.singers[13].pk)

        session.refresh_from_db()
        for sequence in range(3, 6):
            turn = start_challenge_turn(
                session.pk,
                operator=self.admin,
                command_id=f"acceptance-start-{sequence}",
                expected_revision=session.revision,
            )
            waive_challenge_turn(
                session.pk,
                operator=self.admin,
                command_id=f"acceptance-waive-{sequence}",
                expected_revision=turn.session.revision,
                reason="验收流程顺延",
            )
            session.refresh_from_db()
        session = confirm_challenge_session(
            session.pk,
            operator=self.admin,
            command_id="acceptance-confirm-session",
            expected_revision=session.revision,
        )
        final_round = create_final_round_from_challenge(
            session.pk,
            operator=self.admin,
            command_id="acceptance-create-final",
            expected_revision=session.revision,
        )
        self.assertEqual(final_round.status, ContestRound.Status.PREPARED)
        self.assertEqual(
            list(final_round.entries.order_by("running_order").values_list("singer_id", flat=True)),
            [
                self.singers[14].pk,
                self.singers[13].pk,
                *[singer.pk for singer in self.singers[2:10]],
            ],
        )
        self.assertEqual(final_round.scoring_mode, ContestRound.ScoringMode.AVERAGE)

        final_entries = list(final_round.entries.order_by("running_order", "pk"))
        self._score_performances(
            final_round,
            [Decimal(100 - index) for index in range(len(final_entries))],
            self.judges[1:],
        )
        lock_round(final_round, self.admin)
        result = build_podium_result(frozen, self.activity)
        self.assertEqual(result.status, "ready")
        singer_three_score = next(
            decision.score
            for decision in result.decisions
            if decision.contestant == str(self.singers[2].pk)
        )
        self.assertEqual(singer_three_score, Decimal("97.70"))
        self.assertEqual([award.award for award in result.awards], ["冠军", "亚军", "季军"])

    def test_first_round_scoring_groups_must_match_frozen_chorus_groups(self):
        freeze_ruleset_version(self.version, self.admin)
        mismatched: list[dict[str, object]] = [
            {
                "name": spec["name"],
                "singer_ids": list(cast(list[int], spec["singer_ids"])),
            }
            for spec in self.group_specs
        ]
        first_ids = cast(list[int], mismatched[0]["singer_ids"])
        second_ids = cast(list[int], mismatched[1]["singer_ids"])
        mismatched = [
            {
                "name": mismatched[0]["name"],
                "singer_ids": [second_ids[0], *first_ids[1:]],
            },
            {
                "name": mismatched[1]["name"],
                "singer_ids": [first_ids[0], *second_ids[1:]],
            },
            *mismatched[2:],
        ]

        with self.assertRaisesMessage(ValidationError, "已冻结的分组合唱分组一致"):
            set_round_groups(self.first_round, mismatched, self.admin)

    def test_first_round_allows_group_members_in_a_different_performance_order(self):
        freeze_ruleset_version(self.version, self.admin)
        set_round_groups(self.first_round, self.group_specs, self.admin)
        performances = list(
            Performance.objects.filter(group__round=self.first_round, group__sequence=1).order_by(
                "sequence", "pk"
            )
        )
        with authority_write(ROUND_PERFORMANCE_STATE):
            performances[0].sequence = 3
            performances[0].save(update_fields=["sequence"])
            performances[1].sequence = 1
            performances[1].save(update_fields=["sequence"])

        prepared = prepare_round(self.first_round, self.admin)

        self.assertEqual(prepared.status, ContestRound.Status.PREPARED)

    def test_live_freeze_rejects_preexisting_mismatched_scoring_groups(self):
        first_ids = cast(list[int], self.group_specs[0]["singer_ids"])
        second_ids = cast(list[int], self.group_specs[1]["singer_ids"])
        mismatched = [
            {
                "name": self.group_specs[0]["name"],
                "singer_ids": [second_ids[0], *first_ids[1:]],
            },
            {
                "name": self.group_specs[1]["name"],
                "singer_ids": [first_ids[0], *second_ids[1:]],
            },
            *self.group_specs[2:],
        ]

        self.ruleset.group_stage_keys = {}
        self.ruleset.save(update_fields=["group_stage_keys"])
        set_round_groups(self.first_round, mismatched, self.admin)
        self.ruleset.group_stage_keys = {"r1": self.group_stage.pk}
        self.ruleset.save(update_fields=["group_stage_keys"])

        with self.assertRaisesMessage(ValidationError, "评分节目必须与已冻结的分组合唱分组一致"):
            freeze_ruleset_version(self.version, self.admin)

    def test_prepare_rechecks_preexisting_mismatched_scoring_groups(self):
        freeze_ruleset_version(self.version, self.admin)
        with authority_write(ROUND_PERFORMANCE_STATE):
            group = PerformanceGroup.objects.create(
                activity=self.activity,
                round=self.first_round,
                name="第 1 组",
                sequence=1,
                is_test_data=True,
            )
            Performance.objects.create(
                activity=self.activity,
                round=self.first_round,
                singer=self.singers[3],
                group=group,
                sequence=1,
                is_test_data=True,
            )

        with self.assertRaisesMessage(ValidationError, "评分节目必须与已冻结的分组合唱分组一致"):
            prepare_round(self.first_round, self.admin)

    def test_round_groups_page_prefills_frozen_chorus_groups(self):
        freeze_ruleset_version(self.version, self.admin)
        staff_client = Client()
        staff_client.force_login(self.admin)

        response = staff_client.get(reverse("staff:round_groups", args=[self.first_round.pk]))

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.context["frozen_group_snapshot"])
        self.assertContains(response, "已从冻结的分组合唱分组自动填入")
        form = response.context["form"]
        for index, spec in enumerate(self.group_specs, start=1):
            self.assertEqual(form[f"group_name_{index}"].value(), spec["name"])
            self.assertEqual(
                form[f"group_singer_ids_{index}"].value(),
                [str(singer_id) for singer_id in spec["singer_ids"]],
            )

    def test_judge_control_shows_non_blocking_group_material_warning(self):
        freeze_ruleset_version(self.version, self.admin)
        staff_client = Client()
        staff_client.force_login(self.admin)

        response = staff_client.get(reverse("staff:judge_control", args=[self.first_round.pk]))

        self.assertEqual(response.status_code, 200)
        material_status = response.context["live_material_status"]
        self.assertEqual(material_status["missing_count"], 5)
        self.assertContains(response, "仍有 5 组缺少已审核材料")

    def test_builtin_provisioned_ruleset_completes_and_freezes(self):
        """The built-in's preset plus the four operator items must reach a freeze.

        This is the seam that matters: provisioning writes only the format's fixed shape, so
        the ratios and judge lists come from the operator afterwards — and the freeze contract
        has to accept exactly that combination.
        """

        from ruleset.live_format import provision_live_2026_ruleset
        from ruleset.templates import LIVE_2026_BUILTIN_KEY, seed_ruleset_templates

        seed_ruleset_templates(self.admin)
        template = RulesetTemplate.objects.get(builtin_key=LIVE_2026_BUILTIN_KEY)

        # Start from a ruleset carrying only the format's shape, as provisioning leaves it.
        self.ruleset.round_keys = {"r1": self.first_round.pk}
        self.ruleset.live_challenge = {}
        self.ruleset.save(update_fields=["round_keys", "live_challenge"])

        version = provision_live_2026_ruleset(
            self.activity, template=template, name="2026 渡梦内置", operator=self.admin
        )
        self.ruleset.refresh_from_db()
        self.assertEqual(self.ruleset.live_challenge["seat_count"], 10)
        self.assertNotIn("first_round_weight", self.ruleset.live_challenge)
        self.assertEqual(self.ruleset.group_stage_keys["r1"], self.group_stage.pk)

        # The operator fills only the four items the format leaves open.
        update_ruleset_binding(
            self.ruleset,
            binding={
                **_snapshot_binding(self.ruleset),
                "live_challenge": {
                    **self.ruleset.live_challenge,
                    "first_round_weight": "40%",
                    "challenge_round_weight": "60%",
                    "podium_first_round_weight": "30%",
                    "podium_third_round_weight": "70%",
                    "challenge_judge_ids": [judge.pk for judge in self.judges[:4]],
                    "challenge_minimum_judge_count": 4,
                    "final_judge_ids": [judge.pk for judge in self.judges[1:]],
                    "final_minimum_judge_count": 4,
                },
            },
            operator=self.admin,
        )

        self.ruleset.refresh_from_db()
        self.assertEqual(self.ruleset.live_challenge["first_round_weight"], "0.4000")
        self.assertEqual(self.ruleset.live_challenge["podium_first_round_weight"], "0.3000")

        frozen = freeze_ruleset_version(version, self.admin)

        self.assertEqual(frozen.status, RulesetVersion.Status.FROZEN)
        live = frozen.binding["live_challenge"]
        self.assertEqual(live["format_key"], "2026_live_challenge")
        self.assertEqual(live["participant_count"], 15)
        self.assertEqual(live["first_round_weight"], "0.4000")

    def test_live_freeze_requires_five_groups_of_three(self):
        malformed = [
            {
                "name": "第 1 组",
                "singer_ids": [singer.pk for singer in self.singers[:6]],
            },
            *[
                {
                    "name": f"第 {index} 组",
                    "singer_ids": [
                        singer.pk for singer in self.singers[start : start + self.GROUP_SIZE]
                    ],
                }
                for index, start in ((2, 6), (3, 9), (4, 12))
            ],
        ]
        correct_group_stage(
            self.group_stage,
            malformed,
            self.admin,
            reason="现场分组表暂存为四组，验证冻结门禁",
        )

        with self.assertRaisesMessage(ValidationError, "恰好为 5 组"):
            freeze_ruleset_version(self.version, self.admin)

    def test_first_round_http_judge_flow_supports_interleaved_groups_and_late_scores(self):
        freeze_ruleset_version(self.version, self.admin)
        set_round_groups(self.first_round, self.group_specs, self.admin)
        prepared = prepare_round(self.first_round, self.admin)
        prepare_judge_panel(prepared.pk, operator=self.admin)
        with authority_write(ACTIVITY_STATE):
            self.activity.judge_entry_open = True
            self.activity.save(update_fields=["judge_entry_open"])
        self.activity.refresh_from_db()

        judge_clients = []
        capability = judge_entry_credential(self.activity)
        for _ in range(4):
            client = Client()
            response = client.post(
                reverse("judge:claim", args=[self.activity.public_code]),
                data=json.dumps({"judge_entry_token": capability}),
                content_type="application/json",
            )
            self.assertEqual(response.status_code, 201, response.content)
            judge_clients.append(client)

        staff_client = Client()
        staff_client.force_login(self.admin)
        groups = list(PerformanceGroup.objects.filter(round=prepared).order_by("sequence", "pk"))
        performances_by_group = [
            list(group.performances.order_by("sequence", "pk")) for group in groups
        ]

        def pending_version(client, performance_id):
            response = client.get(reverse("judge:context"))
            context = response.json()["context"]
            if context["performance_id"] == performance_id:
                return context["context_version"]
            match = next(
                (
                    item
                    for item in context["pending_performances"]
                    if item["performance_id"] == performance_id
                ),
                None,
            )
            if match is None:
                self.fail(
                    f"performance={performance_id}; context={context}; "
                    f"response={response.content!r}"
                )
            return match["context_version"]

        def submit_http(performance, client_indexes):
            for index in client_indexes:
                response = judge_clients[index].post(
                    reverse("judge:score"),
                    data=json.dumps(
                        {
                            "command_id": f"live-http-{performance.pk}-{index}",
                            "expected_context_version": pending_version(
                                judge_clients[index], performance.pk
                            ),
                            "expected_performance_id": performance.pk,
                            "score_payload": {
                                "criteria": [
                                    {
                                        "criterion_id": self.criterion.pk,
                                        "value": str(90 + index),
                                    }
                                ],
                                "notes": "",
                            },
                        }
                    ),
                    content_type="application/json",
                )
                self.assertEqual(response.status_code, 201, response.content)

        def lock_http(performance):
            state = performance.score_state
            response = staff_client.post(
                reverse("staff:judge_performance_score_lock", args=[prepared.pk]),
                {
                    "performance_id": performance.pk,
                    "context_version": state.context_version,
                    "reason": "第一轮结束收分",
                },
            )
            self.assertEqual(response.status_code, 302, response.content)

        def open_group(group):
            response = staff_client.post(
                reverse("staff:judge_performance_group_advance", args=[prepared.pk]),
                {"group_id": group.pk},
            )
            self.assertEqual(response.status_code, 302, response.content)

        open_group(groups[0])
        submit_http(performances_by_group[0][0], [0, 1, 2])
        submit_http(performances_by_group[0][1], [0, 1, 2, 3])
        submit_http(performances_by_group[0][2], [0, 1, 2, 3])

        # The first group is still short one score, but the next group may open.
        open_group(groups[1])
        for performance in performances_by_group[1]:
            submit_http(performance, [0, 1, 2, 3])

        submit_http(performances_by_group[0][0], [3])
        for performance in performances_by_group[0] + performances_by_group[1]:
            lock_http(performance)

        for group, group_performances in zip(groups[2:], performances_by_group[2:], strict=True):
            open_group(group)
            for performance in group_performances:
                submit_http(performance, [0, 1, 2, 3])
                lock_http(performance)

        lock_round(prepared, self.admin)
        self.assertEqual(ScoreRecord.objects.filter(round=prepared).count(), 15 * 4)
        self.assertEqual(
            PerformanceScoreState.objects.filter(performance__round=prepared).count(), 15
        )
        self.assertFalse(
            PerformanceScoreState.objects.filter(
                performance__round=prepared,
                state__in=[
                    PerformanceScoreState.State.NOT_OPENED,
                    PerformanceScoreState.State.OPEN,
                ],
            ).exists()
        )


class Live2026ReshapedFormatTests(_Live2026AcceptanceFixtureMixin, TestCase):
    """Editing the seat count must leave every copy of that number in step.

    The fixture deliberately keeps the definition at the built-in's shipped 10 while the
    binding and the physical round already say 8 — the state the configuration page used to
    leave behind, and the one that made a reshaped format unfreezable.
    """

    PARTICIPANTS = 12
    SEATS = 8
    GROUP_COUNT = 4
    GROUP_SIZE = 3
    DEFINITION_SELECT_COUNT = 10

    def test_freeze_refuses_while_the_definition_still_says_ten(self):
        with self.assertRaisesMessage(ValidationError, "与初始席位数（8）不一致"):
            freeze_ruleset_version(self.version, self.admin)

    def test_preflight_mirrors_the_freeze_gate(self):
        """The page must never say "全部就绪" while the freeze would refuse."""

        from ruleset.live_format import apply_live_2026_counts, preflight_live_2026

        blocked = [item for item in preflight_live_2026(self.version) if not item.ready]
        self.assertTrue(blocked, "the definition still says 10 while the seats say 8")
        self.assertIn("不一致", " ".join(item.message for item in blocked))

        apply_live_2026_counts(self.ruleset, self.version, operator=self.admin)
        self.version.refresh_from_db()

        items = preflight_live_2026(self.version)
        self.assertTrue(
            all(item.ready for item in items),
            [(item.key, item.message) for item in items if not item.ready],
        )
        # ...and the freeze agrees, which is the whole point of sharing the validators.
        self.assertEqual(
            freeze_ruleset_version(self.version, self.admin).status,
            RulesetVersion.Status.FROZEN,
        )

    def test_syncing_the_counts_makes_the_reshaped_format_freezable(self):
        from ruleset.live_format import apply_live_2026_counts

        apply_live_2026_counts(self.ruleset, self.version, operator=self.admin)

        self.version.refresh_from_db()
        nodes = json.loads(self.version.definition)["nodes"]
        select = next(node for node in nodes if node.get("key") == "top10")
        self.assertEqual(select["count"], 8)
        self.assertEqual(ContestRound.objects.get(pk=self.first_round.pk).advance_count, 8)

        frozen = freeze_ruleset_version(self.version, self.admin)

        self.assertEqual(frozen.status, RulesetVersion.Status.FROZEN)
        self.assertEqual(frozen.binding["live_challenge"]["seat_count"], 8)
        plan = json.loads(frozen.execution_plan or "{}")
        self.assertEqual(plan.get("plan_version"), 1)
