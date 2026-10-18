"""Positive PostgreSQL-sized acceptance path for the 2026 live format."""

import json
import threading
from decimal import Decimal
from typing import TYPE_CHECKING, cast

from accounts.models import User
from accounts.services import mark_admin_verified
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
from django.db import connection
from django.test import Client, TestCase, TransactionTestCase
from django.urls import reverse
from django.utils import timezone
from ruleset.live_format import create_live_2026_group_stage, freeze_blocker
from ruleset.models import ContestRuleset, RulesetTemplate, RulesetVersion
from ruleset.services import (
    _binding_signature,
    _snapshot_binding,
    freeze_ruleset_version,
    supersede_ruleset_version,
    update_ruleset_binding,
)
from ruleset.services import (
    create_ruleset_version as _create_version,
)
from ruleset.templates import LIVE_2026_BUILTIN_KEY
from tests.helpers import postgresql_only

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
    GroupStage,
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
from .services import (
    apply_scores,
    lock_round,
    prepare_round,
    reset_round_to_draft,
    set_round_groups,
)


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


if TYPE_CHECKING:
    # The mixin is only ever combined with ``TestCase``, but it calls ``self.assertEqual``
    # itself; typing it against TestCase is what lets mypy see those assertions.
    _FixtureBase = TestCase
else:
    _FixtureBase = object


class _Live2026AcceptanceFixtureMixin(_FixtureBase):
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

    def test_the_readiness_list_mirrors_the_freeze_gate(self):
        """The page must never say "全部就绪" while the freeze would refuse.

        Two readings of one set of validators: ``freeze_blocker`` is the freeze's own first
        refusal, ``live_2026_readiness`` is every row with its own verdict. They have to agree
        in both directions, or the page is lying to the operator one way or the other.
        """

        from ruleset.live_format import apply_live_2026_counts, freeze_blocker, live_2026_readiness

        blocker = freeze_blocker(self.version)
        self.assertIsNotNone(blocker, "the definition still says 10 while the seats say 8")
        self.assertIn("不一致", blocker.message)

        blocked = [row for row in live_2026_readiness(self.version) if row.state == "blocked"]
        # The gate names the whole first-round family as one step; the checklist splits it into
        # that same family's rows, and the row that carries the gate's own message is the one
        # the operator has to act on.
        self.assertTrue(
            {row.key for row in blocked}
            & {"round_seats", "round_judges", "rubric", "round_contract"}
        )
        self.assertEqual(blocker.message, blocked[0].message)

        apply_live_2026_counts(self.ruleset, self.version, operator=self.admin)
        self.version.refresh_from_db()

        self.assertIsNone(freeze_blocker(self.version))
        unfinished = [
            (row.key, row.state, row.message)
            for row in live_2026_readiness(self.version)
            if not row.ready
        ]
        self.assertEqual(unfinished, [])
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


class Live2026ReadinessPageTests(_Live2026AcceptanceFixtureMixin, TestCase):
    """The pages that render the 准备清单 must answer 200 for every blocker they can report.

    Each row is a link to the page that fixes it, and a row whose route cannot be reversed is
    a 500. The most ordinary unfinished state there is — 第一轮评分表还没填 — used to take down
    the configuration page, the workspace and the pre-launch check at once, because the round
    row reversed ``round_list`` with a version PK that route does not accept.
    """

    def setUp(self):
        super().setUp()
        self.staff = Client()
        self.staff.force_login(self.admin)

    def _config_url(self) -> str:
        return reverse("staff:ruleset_live_2026_config", args=[self.version.pk])

    def test_shrinking_the_seats_on_a_successor_draft_is_refused_with_a_way_out(self):
        """The frozen authority's round may not be moved out from under it.

        v1 is frozen and owns the first round's execution configuration. A successor draft
        asking for 4 seats where the round advances 10 would leave the frozen binding telling
        the venue to seat ten singers the round never produced. The page must refuse the whole
        edit — binding and round are one unit — and name the way that does work.
        """

        live = self.ruleset.live_challenge
        freeze_ruleset_version(self.version, self.admin)
        self.staff.post(
            reverse("staff:contest_ruleset_create"),
            {"activity": self.activity.pk, "name": self.ruleset.name},
        )
        successor = RulesetVersion.objects.get(
            ruleset=self.ruleset, status=RulesetVersion.Status.DRAFT
        )

        current_ruleset = ContestRuleset.objects.get(pk=self.ruleset.pk)
        response = self.staff.post(
            reverse("staff:ruleset_live_2026_config", args=[successor.pk]),
            {
                "base_binding": _binding_signature(current_ruleset),
                "base_binding_revision": current_ruleset.binding_revision,
                "live_participant_count": self.PARTICIPANTS,
                "live_seat_count": 4,
                "live_group_count": live["group_count"],
                "live_group_size": live["group_size"],
                "live_first_weight": "40%",
                "live_challenge_weight": "60%",
                "live_podium_first_weight": "30%",
                "live_podium_third_weight": "70%",
                "live_challenge_judge_ids": [str(judge.pk) for judge in self.judges[:4]],
                "live_challenge_minimum_judges": 4,
                "live_final_judge_ids": [str(judge.pk) for judge in self.judges[1:]],
                "live_final_minimum_judges": 4,
            },
            follow=True,
        )

        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "当前正式赛制仍在使用轮次")
        # The refusal is a refusal: neither the binding nor the round moved.
        self.ruleset.refresh_from_db()
        self.assertEqual(self.ruleset.live_challenge["seat_count"], self.SEATS)
        self.assertEqual(ContestRound.objects.get(pk=self.first_round.pk).advance_count, self.SEATS)

    def test_an_unfilled_first_round_rubric_does_not_take_the_pages_down(self):
        # The rubric is the operator's to attach, so an early draft simply does not have one.
        self.first_round.rubric = None
        self.first_round.save(update_fields=["rubric"])

        response = self.staff.get(self._config_url())

        self.assertEqual(response.status_code, 200)
        rows = {row["key"]: row for row in response.context["checklist"]}
        self.assertFalse(rows["rubric"]["done"])
        # The workbench, not the generic round editor, is where the rubric is filled.
        self.assertEqual(rows["rubric"]["url"], "#section-rubric")
        for row in rows.values():
            if row["done"] or row["key"] == "finality":
                # 已核定结果要靠撤回赛段结果释放，那不是一页配置。
                continue
            self.assertNotEqual(row["url"], "", f"{row['key']} should offer a way to fix it")

    def test_the_workspace_and_the_pre_launch_check_also_answer(self):
        self.first_round.rubric = None
        self.first_round.save(update_fields=["rubric"])

        workspace = self.staff.get(reverse("staff:activity_workspace", args=[self.activity.pk]))
        self.assertEqual(workspace.status_code, 200)
        pre_launch = self.staff.get(reverse("staff:ruleset_validate", args=[self.version.pk]))
        self.assertEqual(pre_launch.status_code, 200)

    def test_the_workspace_offers_the_next_step_for_a_row_that_has_no_round_yet(self):
        """Before provisioning there is no physical round, so the row must not guess one."""

        self.ruleset.round_keys = {}
        self.ruleset.save(update_fields=["round_keys"])

        response = self.staff.get(self._config_url())

        self.assertEqual(response.status_code, 200)
        rows = {row["key"]: row for row in response.context["checklist"]}
        self.assertTrue(rows["round_seats"]["url"].startswith(reverse("staff:round_create")))
        self.assertIn(f"activity_id={self.activity.pk}", rows["round_seats"]["url"])

    def _config_post(self, **overrides):
        live = self.ruleset.live_challenge
        current_ruleset = ContestRuleset.objects.get(pk=self.ruleset.pk)
        data = {
            "base_binding": _binding_signature(current_ruleset),
            "base_binding_revision": current_ruleset.binding_revision,
            "live_participant_count": str(self.PARTICIPANTS),
            "live_seat_count": str(self.SEATS),
            "live_group_count": str(self.GROUP_COUNT),
            "live_group_size": str(self.GROUP_SIZE),
            "live_first_weight": live["first_round_weight"],
            "live_challenge_weight": live["challenge_round_weight"],
            "live_podium_first_weight": live["podium_first_round_weight"],
            "live_podium_third_weight": live["podium_third_round_weight"],
            "live_challenge_judge_ids": [str(judge.pk) for judge in self.judges[:4]],
            "live_challenge_minimum_judges": str(live["challenge_minimum_judge_count"]),
            "live_final_judge_ids": [str(judge.pk) for judge in self.judges[1:]],
            "live_final_minimum_judges": str(live["final_minimum_judge_count"]),
            "live_first_judge_count": str(self.first_round.judge_count or ""),
            "live_first_minimum_judges": str(self.first_round.minimum_judge_count or ""),
            "live_first_rubric_id": str(self.first_round.rubric_id or ""),
        }
        data.update(overrides)
        return data

    def _tasks(self):
        response = self.staff.get(self._config_url())
        self.assertEqual(response.status_code, 200)
        tasks = {task["key"]: task for task in response.context["tasks"]}
        return (
            response,
            tasks,
            response.context["completed_count"],
            response.context["remaining_count"],
        )

    def test_filling_both_weight_pairs_completes_two_tasks_and_never_goes_back(self):
        config = dict(self.ruleset.live_challenge)
        config.update(
            {
                "first_round_weight": "",
                "challenge_round_weight": "",
                "podium_first_round_weight": "",
                "podium_third_round_weight": "",
            }
        )
        self.ruleset.live_challenge = config
        self.ruleset.save(update_fields=["live_challenge"])

        _, tasks, before_completed, before_remaining = self._tasks()
        self.assertFalse(tasks["challenge_weights"]["ready"])
        self.assertFalse(tasks["podium_weights"]["ready"])

        self.staff.post(
            self._config_url(),
            self._config_post(
                live_first_weight="40%",
                live_challenge_weight="60%",
                live_podium_first_weight="30%",
                live_podium_third_weight="70%",
            ),
            follow=True,
        )

        response, tasks, after_completed, after_remaining = self._tasks()
        self.assertTrue(tasks["challenge_weights"]["ready"])
        self.assertTrue(tasks["podium_weights"]["ready"])
        self.assertEqual(after_completed, before_completed + 2)
        self.assertEqual(after_remaining, before_remaining - 2)
        self.assertEqual(response.context["weights"]["first_round_weight"], "40")
        self.assertEqual(response.context["weights"]["podium_third_round_weight"], "70")

    def test_filling_the_judge_panels_completes_its_task(self):
        config = dict(self.ruleset.live_challenge)
        config.update({"challenge_judge_ids": [], "final_judge_ids": []})
        self.ruleset.live_challenge = config
        self.ruleset.save(update_fields=["live_challenge"])

        _, tasks, before_completed, before_remaining = self._tasks()
        self.assertFalse(tasks["judges"]["ready"])

        self.staff.post(self._config_url(), self._config_post(), follow=True)

        _, tasks, after_completed, after_remaining = self._tasks()
        self.assertTrue(tasks["judges"]["ready"])
        self.assertEqual(after_completed, before_completed + 1)
        self.assertEqual(after_remaining, before_remaining - 1)

    def test_the_workbench_fills_first_round_judges_and_rubric_without_the_round_editor(self):
        rubric = self.first_round.rubric
        with authority_write(CONTEST_ROUND_STATE):
            self.first_round.judge_count = None
            self.first_round.minimum_judge_count = None
            self.first_round.rubric = None
            self.first_round.save(update_fields=["judge_count", "minimum_judge_count", "rubric"])

        _, tasks, before_completed, before_remaining = self._tasks()
        self.assertFalse(tasks["judges"]["ready"])
        self.assertFalse(tasks["rubric"]["ready"])

        self.staff.post(
            self._config_url(),
            self._config_post(
                live_first_judge_count=str(self.JUDGE_COUNT),
                live_first_minimum_judges="4",
                live_first_rubric_id=str(rubric.pk),
            ),
            follow=True,
        )

        self.first_round.refresh_from_db()
        self.assertEqual(self.first_round.judge_count, self.JUDGE_COUNT)
        self.assertEqual(self.first_round.minimum_judge_count, 4)
        self.assertEqual(self.first_round.rubric_id, rubric.pk)
        _, tasks, after_completed, after_remaining = self._tasks()
        self.assertTrue(tasks["judges"]["ready"])
        self.assertTrue(tasks["rubric"]["ready"])
        self.assertEqual(after_completed, before_completed + 2)
        self.assertEqual(after_remaining, before_remaining - 2)

    def test_the_workbench_can_create_a_rubric_inline(self):
        with authority_write(CONTEST_ROUND_STATE):
            self.first_round.rubric = None
            self.first_round.save(update_fields=["rubric"])

        self.staff.post(
            self._config_url(),
            self._config_post(
                live_first_rubric_id="",
                live_new_rubric_name="现场评分表",
                live_new_rubric_criteria="演唱技巧,40\n舞台表现,30\n情感表达,30",
            ),
            follow=True,
        )

        self.first_round.refresh_from_db()
        rubric = ScoringRubric.objects.get(pk=self.first_round.rubric_id)
        self.assertEqual(rubric.name, "现场评分表")
        self.assertEqual(rubric.criteria.count(), 3)
        self.assertEqual(
            sum(criterion.max_score for criterion in rubric.criteria.all()),
            Decimal("100"),
        )

    def test_the_checklist_links_each_task_to_the_page_that_fixes_it(self):
        response, _, _, _ = self._tasks()
        rows = {row["key"]: row for row in response.context["checklist"]}

        self.assertEqual(
            rows["groups"]["url"],
            reverse("staff:group_stage_detail", args=[self.group_stage.pk]),
        )
        self.assertEqual(rows["rubric"]["url"], "#section-rubric")
        self.assertEqual(rows["round_judges"]["url"], "#section-judges")
        self.assertEqual(rows["round_seats"]["url"], "#section-people")
        for key in ("round_seats", "round_judges", "rubric"):
            self.assertNotIn("/rounds/", rows[key]["url"])

    def test_a_stale_first_round_configuration_is_refused(self):
        page = self.staff.get(self._config_url())
        stale_configuration = page.context["base_first_round_configuration"]

        # Another staff member changes the first round while this page sits open.
        with authority_write(CONTEST_ROUND_STATE):
            self.first_round.judge_count = self.JUDGE_COUNT + 1
            self.first_round.save(update_fields=["judge_count"])

        response = self.staff.post(
            self._config_url(),
            self._config_post(
                base_first_round_configuration=stale_configuration,
                live_first_judge_count=str(self.JUDGE_COUNT + 1),
            ),
            follow=True,
        )

        self.assertContains(response, "第一轮配置已被其他工作人员修改")
        self.first_round.refresh_from_db()
        self.assertEqual(self.first_round.judge_count, self.JUDGE_COUNT + 1)

    def test_an_unrelated_round_change_does_not_conflict(self):
        page = self.staff.get(self._config_url())
        token = page.context["base_first_round_configuration"]

        with authority_write(CONTEST_ROUND_STATE):
            other = ContestRound.objects.create(
                activity=self.activity,
                round_type=ContestRound.RoundType.SEMI_FINAL,
                name="无关的另一个轮次",
                judge_count=3,
            )
            other.minimum_judge_count = 2
            other.save(update_fields=["minimum_judge_count"])

        response = self.staff.post(
            self._config_url(),
            self._config_post(base_first_round_configuration=token),
            follow=True,
        )

        self.assertContains(response, "已保存")

    def test_a_frozen_authority_is_shown_as_official_not_as_an_editable_draft(self):
        """The workspace used to offer "继续准备今年赛制" on a frozen version, i.e. a 403."""

        freeze_ruleset_version(self.version, self.admin)

        response = self.staff.get(reverse("staff:activity_workspace", args=[self.activity.pk]))

        self.assertEqual(response.status_code, 200)
        summary = response.context["ruleset_summary"]
        self.assertTrue(summary["is_frozen"])
        self.assertEqual(summary["continue_url"], "")
        self.assertContains(response, "今年赛制已经正式冻结")
        self.assertContains(response, "创建后继草稿")
        self.assertNotContains(
            response, reverse("staff:ruleset_live_2026_config", args=[self.version.pk])
        )

    def test_issuing_a_successor_draft_from_the_workspace_lands_on_the_editor(self):
        freeze_ruleset_version(self.version, self.admin)
        frozen_pk = self.version.pk

        response = self.staff.post(
            reverse("staff:contest_ruleset_create"),
            {"activity": self.activity.pk, "name": "2026 院十佳现场赛制"},
        )

        successor = RulesetVersion.objects.get(
            ruleset=self.ruleset, status=RulesetVersion.Status.DRAFT
        )
        self.assertEqual(response.status_code, 302)
        # The configuration page, not the read-only planning workbench.
        self.assertEqual(
            response["Location"], reverse("staff:ruleset_live_2026_config", args=[successor.pk])
        )
        self.assertEqual(successor.pk, max(self.ruleset.versions.values_list("pk", flat=True)))
        # The running authority is untouched until the successor is frozen.
        self.assertTrue(RulesetVersion.objects.get(pk=frozen_pk).is_current)

    def test_an_older_draft_hands_over_to_the_newest_one(self):
        """Two drafts share one binding surface, so only the newest one may write it."""

        from ruleset.services import create_ruleset_version as _create_version

        newer = _create_version(
            self.ruleset, definition=self.version.definition, created_by=self.admin
        )

        stale_get = self.staff.get(
            reverse("staff:ruleset_live_2026_config", args=[self.version.pk])
        )
        self.assertEqual(stale_get.status_code, 302)
        self.assertEqual(
            stale_get["Location"],
            reverse("staff:ruleset_live_2026_config", args=[newer.pk]),
        )

        # And a POST from the stale page cannot write the shared binding either.
        stale_post = self.staff.post(
            reverse("staff:ruleset_live_2026_config", args=[self.version.pk]),
            {"live_participant_count": "15", "live_seat_count": "4"},
        )
        self.assertEqual(stale_post.status_code, 403)
        self.assertEqual(self.ruleset.live_challenge["seat_count"], self.SEATS)


class Live2026VersionLifecycleTests(_Live2026AcceptanceFixtureMixin, TestCase):
    """What the operator sees right after the format becomes official.

    Three seams the happy path crosses and nothing pinned: the page a freeze lands on, the
    guidance a successor gives about the round it cannot move, and what happens to an older
    draft once a newer version is the authority.
    """

    def setUp(self):
        super().setUp()
        from accounts.services import mark_admin_verified

        self.staff = Client()
        # Freezing is @admin_required, which reads the elevated-verification marker rather
        # than the role alone.
        self.staff.force_login(self.admin)
        session = self.staff.session
        mark_admin_verified(session)
        session.save()

    def _config_url(self, version=None) -> str:
        return reverse("staff:ruleset_live_2026_config", args=[(version or self.version).pk])

    def _prepared_first_round(self):
        """A first round the running authority owns *and* has already prepared."""

        freeze_ruleset_version(self.version, self.admin)
        set_round_groups(self.first_round, self.group_specs, self.admin)
        prepare_round(self.first_round, self.admin)
        self.first_round.refresh_from_db()
        self.assertEqual(self.first_round.status, ContestRound.Status.PREPARED)
        return supersede_ruleset_version(self.version, created_by=self.admin)

    def _bound_first_round(self):
        """A first round the running authority owns, before the venue touches it."""

        freeze_ruleset_version(self.version, self.admin)
        return supersede_ruleset_version(self.version, created_by=self.admin)

    def _seat_change_payload(self, seats):
        live = self.ruleset.live_challenge
        current_ruleset = ContestRuleset.objects.get(pk=self.ruleset.pk)
        return {
            "base_binding": _binding_signature(current_ruleset),
            "base_binding_revision": current_ruleset.binding_revision,
            "live_participant_count": self.PARTICIPANTS,
            "live_seat_count": seats,
            "live_group_count": live["group_count"],
            "live_group_size": live["group_size"],
            "live_first_weight": "40%",
            "live_challenge_weight": "60%",
            "live_podium_first_weight": "30%",
            "live_podium_third_weight": "70%",
            "live_challenge_judge_ids": [str(judge.pk) for judge in self.judges[:4]],
            "live_challenge_minimum_judges": 4,
            "live_final_judge_ids": [str(judge.pk) for judge in self.judges[1:]],
            "live_final_minimum_judges": 4,
        }

    def test_a_successful_freeze_lands_somewhere_that_accepts_it(self):
        """The freeze used to succeed and then redirect the operator into a 403.

        ``ruleset_edit`` refuses a frozen version, so the row froze, the success message was
        replaced by an error page, and the honest reading of the screen was "it failed".
        """

        response = self.staff.post(
            reverse("staff:ruleset_freeze", args=[self.version.pk]), follow=True
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.redirect_chain[-1][0],
            reverse("staff:activity_workspace", args=[self.activity.pk]),
        )
        self.assertContains(response, "赛制已冻结")
        self.version.refresh_from_db()
        self.assertEqual(self.version.status, RulesetVersion.Status.FROZEN)

        # The workspace's frozen view is the pair of links that must work from here.
        view_url = reverse("staff:ruleset_validate", args=[self.version.pk])
        self.assertContains(response, view_url)
        self.assertEqual(self.staff.get(view_url).status_code, 200)
        self.assertContains(response, "创建后继草稿")

    def test_a_failed_freeze_leaves_the_operator_on_the_editor(self):
        """A refusal has to land where the fix is, not on the workspace."""

        self.first_round.rubric = None
        self.first_round.save(update_fields=["rubric"])

        response = self.staff.post(
            reverse("staff:ruleset_freeze", args=[self.version.pk]), follow=True
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.redirect_chain[-1][0], self._config_url())
        self.version.refresh_from_db()
        self.assertEqual(self.version.status, RulesetVersion.Status.DRAFT)

    def test_the_freeze_button_is_disabled_while_a_blocker_stands(self):
        self.first_round.rubric = None
        self.first_round.save(update_fields=["rubric"])

        response = self.staff.get(self._config_url())

        self.assertIsNotNone(response.context["blocker"])
        self.assertContains(response, "<button disabled")
        self.assertContains(response, "先处理上面的阻塞项")

    def test_a_successor_offers_a_new_round_instead_of_resetting_the_running_one(self):
        """Reset destroys prepared data and the guard still refuses afterwards.

        The round the running authority binds cannot be moved, so resetting it is not a step
        towards changing the number — it is only the loss of the prepared first round. That
        state must offer the clone-and-rebind action and never the reset button.
        """

        successor = self._prepared_first_round()

        response = self.staff.get(self._config_url(successor))

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.context["first_round_is_protected"])
        self.assertFalse(response.context["first_round_needs_reset"])
        self.assertContains(response, "为这一版赛制复制一个可编辑的第一轮")
        self.assertNotContains(response, "重置第一轮并继续修改")
        self.assertNotContains(response, f"/staff/rounds/{self.first_round.pk}/reset/")

    def test_cloning_the_first_round_makes_the_seat_change_one_save(self):
        """The escape hatch end to end: clone, rebind, change the number, freeze.

        The reshape happens before the venue starts, which is the whole point: once the
        first round is prepared the format can no longer be swapped underneath it.
        """

        successor = self._bound_first_round()
        running_round = ContestRound.objects.get(pk=self.ruleset.round_keys["r1"])

        response = self.staff.post(
            reverse("staff:ruleset_live_2026_clone_first_round", args=[successor.pk]),
            follow=True,
        )

        self.assertEqual(response.status_code, 200)
        self.ruleset.refresh_from_db()
        cloned = ContestRound.objects.get(pk=self.ruleset.round_keys["r1"])
        self.assertNotEqual(cloned.pk, running_round.pk)
        self.assertEqual(cloned.status, ContestRound.Status.DRAFT)
        # Configuration comes across; nothing the running round has recorded does.
        self.assertEqual(cloned.judge_count, running_round.judge_count)
        self.assertEqual(cloned.minimum_judge_count, running_round.minimum_judge_count)
        self.assertEqual(cloned.rubric_id, running_round.rubric_id)
        self.assertEqual(cloned.scoring_mode, running_round.scoring_mode)
        self.assertEqual(cloned.entries.count(), 0)
        # The authority keeps the round it promised.
        running_round.refresh_from_db()
        self.assertEqual(running_round.status, ContestRound.Status.DRAFT)
        self.assertEqual(running_round.advance_count, self.SEATS)

        saved = self.staff.post(
            self._config_url(successor),
            self._seat_change_payload(self.SEATS - 2),
            follow=True,
        )

        self.assertEqual(saved.status_code, 200)
        self.assertContains(saved, "已保存")
        cloned.refresh_from_db()
        self.assertEqual(cloned.advance_count, self.SEATS - 2)
        running_round.refresh_from_db()
        self.assertEqual(running_round.advance_count, self.SEATS)
        successor.refresh_from_db()
        select = next(
            node for node in json.loads(successor.definition)["nodes"] if node.get("key") == "top10"
        )
        self.assertEqual(select["count"], self.SEATS - 2)
        # And the reshaped successor can actually be frozen, because the venue has not
        # started: the round it leaves behind is still a draft.
        self.assertIsNone(freeze_blocker(successor))
        freeze_ruleset_version(successor, self.admin)
        self.ruleset.refresh_from_db()
        self.assertEqual(self.ruleset.round_keys["r1"], cloned.pk)

    def test_provisioning_the_builtin_lands_on_the_2026_configuration_page(self):
        """The entry point for the built-in dropped the operator on the advanced editor.

        The 2026 page exists for exactly the work provisioning leaves open — the ratios, the
        three judge lists, the rubric — and the editor then offered it as "推荐". Opening the
        page the operator needs is the whole point of having built it.
        """

        from ruleset.templates import LIVE_2026_BUILTIN_KEY, seed_ruleset_templates

        seed_ruleset_templates(self.admin)
        template = RulesetTemplate.objects.get(builtin_key=LIVE_2026_BUILTIN_KEY)

        response = self.staff.post(
            reverse("staff:contest_ruleset_create"),
            {"activity": self.activity.pk, "name": "2026 渡梦现场赛制", "template": template.pk},
        )

        newest = RulesetVersion.objects.filter(ruleset=self.ruleset).order_by("-version").first()
        self.assertIsNotNone(newest)
        assert newest is not None  # for the type checker, not for the test
        self.assertEqual(response.status_code, 302)
        self.assertEqual(
            response["Location"], reverse("staff:ruleset_live_2026_config", args=[newest.pk])
        )

    def test_cloning_the_first_round_copies_its_execution_configuration(self):
        """The copy has to be the round the operator was looking at, not a defaults reset.

        ``order_policy`` and ``tie_order_policy`` are execution semantics: a clone that came
        back as the model default would change how the venue calls singers up, silently.
        """

        successor = self._bound_first_round()
        running = ContestRound.objects.get(pk=self.ruleset.round_keys["r1"])
        running.order_policy = ContestRound.OrderPolicy.DRAW
        running.tie_order_policy = ContestRound.TieOrderPolicy.DRAW
        running.scheduled_at = timezone.now()
        running.venue = "屏峰校区体育馆"
        with authority_write(CONTEST_ROUND_STATE):
            running.save(
                update_fields=["order_policy", "tie_order_policy", "scheduled_at", "venue"]
            )

        self.staff.post(
            reverse("staff:ruleset_live_2026_clone_first_round", args=[successor.pk]),
            follow=True,
        )

        self.ruleset.refresh_from_db()
        cloned = ContestRound.objects.get(pk=self.ruleset.round_keys["r1"])
        self.assertNotEqual(cloned.pk, running.pk)
        self.assertEqual(cloned.order_policy, ContestRound.OrderPolicy.DRAW)
        self.assertEqual(cloned.tie_order_policy, ContestRound.TieOrderPolicy.DRAW)
        self.assertEqual(cloned.scheduled_at, running.scheduled_at)
        self.assertEqual(cloned.venue, "屏峰校区体育馆")

    def test_an_older_draft_is_history_once_its_successor_is_frozen(self):
        """``v1 DRAFT`` beside ``v2 FROZEN`` must not be an editing target.

        The workspace used to prefer any draft over the authority, and the pages used to ask
        only for a newer *draft* — so v1 stayed editable, and freezing it would have demoted
        v2 and moved the activity's authority backwards to a definition it had left behind.
        """

        older = self.version
        newer = _create_version(self.ruleset, definition=older.definition, created_by=self.admin)
        freeze_ruleset_version(newer, self.admin)

        workspace = self.staff.get(reverse("staff:activity_workspace", args=[self.activity.pk]))
        summary = workspace.context["ruleset_summary"]
        self.assertTrue(summary["is_frozen"])
        self.assertEqual(summary["version"].pk, newer.pk)

        # Neither the 2026 page nor the generic editor will open it for writing.
        for route in ("staff:ruleset_live_2026_config", "staff:ruleset_edit"):
            with self.subTest(route=route):
                page = self.staff.get(reverse(route, args=[older.pk]))
                self.assertEqual(page.status_code, 302)
                self.assertEqual(
                    page["Location"],
                    reverse("staff:activity_workspace", args=[self.activity.pk]),
                )
                write = self.staff.post(reverse(route, args=[older.pk]), {})
                self.assertEqual(write.status_code, 403)

        # And the service refuses the freeze even if a page were bypassed.
        with self.assertRaisesMessage(ValidationError, "不能冻结旧版本"):
            freeze_ruleset_version(older, self.admin)
        newer.refresh_from_db()
        self.assertTrue(newer.is_current)


class Live2026RoundExecutionAuthorityTests(_Live2026AcceptanceFixtureMixin, TestCase):
    """The last gate between a frozen format and the venue.

    Two holes on either side of the same boundary. A round that a *successor draft* had
    cloned in could start the whole live scoring chain while its own version was still a
    draft, because the roster source is 报名名单 and the setup readiness answered READY
    without ever asking which format the round belonged to. And a successor could take
    authority away from a format that was already running, because the only finality check
    was a CONFIRMED stage result — a state that arrives at the *end* of a round, long after
    the venue is using it.
    """

    def setUp(self):
        super().setUp()
        self.staff = Client()
        self.staff.force_login(self.admin)

    def _successor_with_a_cloned_first_round(self):
        """v1 frozen on the first round, v2 a draft that binds its own copied round."""

        freeze_ruleset_version(self.version, self.admin)
        running = ContestRound.objects.get(pk=self.first_round.pk)
        successor = supersede_ruleset_version(self.version, created_by=self.admin)
        response = self.staff.post(
            reverse("staff:ruleset_live_2026_clone_first_round", args=[successor.pk]),
            follow=True,
        )
        self.assertEqual(response.status_code, 200)
        self.ruleset.refresh_from_db()
        cloned = ContestRound.objects.get(pk=self.ruleset.round_keys["r1"])
        self.assertNotEqual(cloned.pk, running.pk)
        return successor, running, cloned

    def _start_round(self, contest_round) -> ContestRound:
        set_round_groups(contest_round, self.group_specs, self.admin)
        return prepare_round(contest_round, self.admin)

    def test_a_cloned_round_cannot_start_before_its_own_version_is_frozen(self):
        """The escape hatch does not hand out a running round on credit."""

        successor, _running, cloned = self._successor_with_a_cloned_first_round()
        set_round_groups(cloned, self.group_specs, self.admin)

        with self.assertRaisesMessage(ValidationError, "不属于当前正式赛制"):
            prepare_round(cloned, self.admin)
        self.assertEqual(ContestRound.objects.get(pk=cloned.pk).status, ContestRound.Status.DRAFT)

        freeze_ruleset_version(successor, self.admin)

        self.assertEqual(prepare_round(cloned, self.admin).status, ContestRound.Status.PREPARED)

    def test_the_round_a_replaced_authority_bound_cannot_start_under_the_new_one(self):
        """The other direction: an old round does not inherit the new authority."""

        successor, running, cloned = self._successor_with_a_cloned_first_round()
        freeze_ruleset_version(successor, self.admin)

        set_round_groups(running, self.group_specs, self.admin)
        with self.assertRaisesMessage(ValidationError, "不属于当前正式赛制"):
            prepare_round(running, self.admin)

        set_round_groups(cloned, self.group_specs, self.admin)
        self.assertEqual(prepare_round(cloned, self.admin).status, ContestRound.Status.PREPARED)

    def test_prepare_judge_panel_asks_the_same_question(self):
        """Defense in depth: the panel is a second door onto the same room.

        It reads the round's own status, which is *not* the authority — a round can carry
        PREPARED from a format that has since been replaced. The round is put in that state
        directly, because what is pinned here is that this guard holds on its own.
        """

        successor, running, _cloned = self._successor_with_a_cloned_first_round()
        freeze_ruleset_version(successor, self.admin)
        running.status = ContestRound.Status.PREPARED
        with authority_write(CONTEST_ROUND_STATE):
            running.save(update_fields=["status"])

        with self.assertRaisesMessage(ValidationError, "不属于当前正式赛制"):
            prepare_judge_panel(running.pk, operator=self.admin)

    def test_the_round_list_does_not_offer_to_start_a_round_the_format_does_not_bind(self):
        """The same false affordance as the editors, on the page the button is clicked.

        The list reads each round's own setup readiness, so an unbound round reads as 就绪
        and the button promises a click the service would refuse.
        """

        _successor, running, cloned = self._successor_with_a_cloned_first_round()

        response = self.staff.get(reverse("staff:round_list"))

        self.assertEqual(response.status_code, 200)
        self.assertNotContains(response, reverse("staff:round_prepare", args=[cloned.pk]))
        self.assertContains(response, reverse("staff:round_prepare", args=[running.pk]))
        self.assertContains(response, "不属于当前正式赛制")

    def test_a_round_no_binding_ever_named_cannot_start(self):
        """Unbound is not the same as "the format made it".

        The gate has to leave the challenge's own scoring rounds alone — they are created at
        the venue and belong to no binding — and it used to do that by asking only whether
        any binding had ever named a round. That let an operator hand-create a round in an
        activity with an official format and start it: entries, a panel, performances and
        scores outside the format, and an open panel that then blocks a successor freeze.
        """

        freeze_ruleset_version(self.version, self.admin)
        extra = ContestRound.objects.create(
            activity=self.activity,
            round_type=ContestRound.RoundType.PRELIMINARY,
            name="临时加的轮次",
            sequence=9,
        )

        with self.assertRaisesMessage(ValidationError, "不属于当前正式赛制"):
            prepare_round(extra, self.admin)

        extra.status = ContestRound.Status.PREPARED
        with authority_write(CONTEST_ROUND_STATE):
            extra.save(update_fields=["status"])
        with self.assertRaisesMessage(ValidationError, "不属于当前正式赛制"):
            prepare_judge_panel(extra.pk, operator=self.admin)

    def test_a_successor_cannot_take_over_a_format_that_is_already_running(self):
        """Prepared and panel-open is running, even with no result confirmed yet."""

        freeze_ruleset_version(self.version, self.admin)
        self._start_round(self.first_round)
        prepare_judge_panel(self.first_round.pk, operator=self.admin)
        successor = supersede_ruleset_version(self.version, created_by=self.admin)

        blocker = freeze_blocker(successor)
        self.assertIsNotNone(blocker)
        assert blocker is not None  # for the type checker, not for the test
        self.assertEqual(blocker.key, "finality")
        self.assertIn("已经开始现场运行", blocker.message)
        self.assertIn("已经准备", blocker.message)
        self.assertIn("现场评委组已经建立", blocker.message)

        with self.assertRaisesMessage(ValidationError, "已经开始现场运行"):
            freeze_ruleset_version(successor, self.admin)
        self.version.refresh_from_db()
        self.assertTrue(self.version.is_current)

        # The way out is stated and it works: unwind the prepared round, then freeze.
        reset_round_to_draft(self.first_round, self.admin, reason="换版前撤销现场准备")
        self.first_round.refresh_from_db()
        self.assertEqual(self.first_round.status, ContestRound.Status.DRAFT)

        frozen = freeze_ruleset_version(successor, self.admin)
        self.assertTrue(frozen.is_current)
        self.version.refresh_from_db()
        self.assertFalse(self.version.is_current)


class Live2026FreshWorkbenchTests(TestCase):
    """A brand-new built-in activity is completed through Staff HTTP routes only.

    No fixture pre-binds a GroupStage, no test writes ``group_stage_keys`` directly, and
    no step opens the generic round editor. If this passes, a staff member who has never
    heard of ContestRound or GroupStage can go from "new activity" to "frozen format".
    """

    def setUp(self):
        from django.core.management import call_command

        call_command("seed_ruleset_templates")
        with authority_write(ACCOUNT_AUTHORITY):
            self.admin = User.objects.create_user(
                username="fresh-workbench-admin", password="pass", role=User.Role.ADMIN
            )
        with authority_write(ACTIVITY_STATE):
            self.activity = Activity.objects.create(
                title="2026 全新工作台",
                activity_type=Activity.Type.SINGER_CONTEST,
                is_test_mode=True,
            )
        transition_activity_phase(self.activity, Activity.Phase.TESTING, actor=self.admin)
        self.judges = [
            Judge.objects.create(activity=self.activity, name=f"现场评委 {index}")
            for index in range(1, 6)
        ]
        self.singers = []
        for number in range(1, 16):
            with authority_write(ACCOUNT_AUTHORITY):
                user = User.objects.create_user(
                    username=f"fresh-workbench-singer-{number}", password="pass"
                )
            singer = SingerRegistration.objects.create(
                activity=self.activity,
                user=user,
                name=f"选手 {number}",
                student_id=f"fresh-workbench-{number:02d}",
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
        self.client.force_login(self.admin)
        session = self.client.session
        mark_admin_verified(session)
        session.save()

    def _config_url(self, version: RulesetVersion) -> str:
        return reverse("staff:ruleset_live_2026_config", args=[version.pk])

    def test_a_fresh_built_in_is_prepared_grouped_and_frozen_through_the_ui(self):
        template = RulesetTemplate.objects.get(builtin_key=LIVE_2026_BUILTIN_KEY)
        response = self.client.post(
            reverse("staff:ruleset_clone_from_template", args=[template.pk]),
            {"activity": self.activity.pk, "name": "2026 渡梦工作台"},
            follow=True,
        )
        self.assertEqual(response.status_code, 200)
        version = RulesetVersion.objects.get(ruleset__activity=self.activity)
        ruleset = version.ruleset
        first_round = ContestRound.objects.get(pk=ruleset.round_keys["r1"])

        # Genuinely fresh: the operator items and the grouping are still empty.
        self.assertIsNone(first_round.judge_count)
        self.assertIsNone(first_round.rubric_id)
        self.assertEqual(ruleset.group_stage_keys, {})

        page = self.client.get(self._config_url(version))
        self.assertEqual(page.status_code, 200)
        tasks = {task["key"]: task for task in page.context["tasks"]}
        self.assertFalse(tasks["challenge_weights"]["ready"])
        self.assertFalse(tasks["podium_weights"]["ready"])
        self.assertFalse(tasks["groups"]["ready"])

        saved = self.client.post(
            self._config_url(version),
            {
                "base_binding": page.context["binding_signature"],
                "base_binding_revision": page.context["binding_revision"],
                "base_first_round_configuration": page.context["base_first_round_configuration"],
                "live_participant_count": "15",
                "live_seat_count": "10",
                "live_group_count": "5",
                "live_group_size": "3",
                "live_first_weight": "40",
                "live_challenge_weight": "60",
                "live_podium_first_weight": "30",
                "live_podium_third_weight": "70",
                "live_challenge_judge_ids": [str(judge.pk) for judge in self.judges[:4]],
                "live_challenge_minimum_judges": "4",
                "live_final_judge_ids": [str(judge.pk) for judge in self.judges[1:]],
                "live_final_minimum_judges": "4",
                "live_first_judge_count": "5",
                "live_first_minimum_judges": "4",
                "live_new_rubric_name": "2026 统一评分表",
                "live_new_rubric_criteria": "演唱技巧,40\n舞台表现,30\n情感表达,30",
            },
            follow=True,
        )
        self.assertEqual(saved.status_code, 200)
        self.assertContains(saved, "已保存")
        first_round.refresh_from_db()
        self.assertEqual(first_round.judge_count, 5)
        self.assertEqual(first_round.minimum_judge_count, 4)
        self.assertIsNotNone(first_round.rubric_id)

        page = self.client.get(self._config_url(version))
        tasks = {task["key"]: task for task in page.context["tasks"]}
        self.assertTrue(tasks["challenge_weights"]["ready"])
        self.assertTrue(tasks["podium_weights"]["ready"])
        self.assertTrue(tasks["judges"]["ready"])
        self.assertTrue(tasks["rubric"]["ready"])
        self.assertFalse(tasks["groups"]["ready"])

        self.client.post(self._config_url(version), {"action": "create_group_stage"}, follow=True)
        stage = GroupStage.objects.get(
            activity=self.activity, managed_by=GroupStage.ManagedBy.LIVE_2026
        )
        payload: dict[str, object] = {}
        for index, start in enumerate(range(0, 15, 3), start=1):
            payload[f"group_name_{index}"] = f"第 {index} 组"
            payload[f"group_singer_ids_{index}"] = [
                str(singer.pk) for singer in self.singers[start : start + 3]
            ]
        self.client.post(reverse("staff:group_stage_record", args=[stage.pk]), payload, follow=True)
        self.client.post(reverse("staff:group_stage_confirm", args=[stage.pk]), follow=True)
        self.client.post(reverse("staff:group_stage_freeze", args=[stage.pk]), follow=True)

        stage.refresh_from_db()
        ruleset.refresh_from_db()
        self.assertEqual(stage.status, GroupStage.Status.FROZEN)
        self.assertEqual(ruleset.group_stage_keys, {"r1": stage.pk})

        page = self.client.get(self._config_url(version))
        self.assertEqual(page.context["completed_count"], 7)
        self.assertEqual(page.context["remaining_count"], 0)

        frozen = self.client.post(reverse("staff:ruleset_freeze", args=[version.pk]), follow=True)
        self.assertEqual(frozen.status_code, 200)
        version.refresh_from_db()
        self.assertEqual(version.status, RulesetVersion.Status.FROZEN)
        self.assertTrue(version.is_current)
        self.assertEqual(version.binding["group_stage_keys"], {"r1": stage.pk})

    def _form_data(self, page, *, group_count=5, include_first_round=False):
        data = {
            "base_binding": page.context["binding_signature"],
            "base_binding_revision": page.context["binding_revision"],
            "base_first_round_configuration": page.context["base_first_round_configuration"],
            "live_participant_count": "15",
            "live_seat_count": "10",
            "live_group_count": str(group_count),
            "live_group_size": "3",
            "live_first_weight": "40",
            "live_challenge_weight": "60",
            "live_podium_first_weight": "30",
            "live_podium_third_weight": "70",
            "live_challenge_judge_ids": [str(judge.pk) for judge in self.judges[:4]],
            "live_challenge_minimum_judges": "4",
            "live_final_judge_ids": [str(judge.pk) for judge in self.judges[1:]],
            "live_final_minimum_judges": "4",
        }
        if include_first_round:
            data.update(
                {
                    "live_first_judge_count": "5",
                    "live_first_minimum_judges": "4",
                    "live_new_rubric_name": "统一评分表",
                    "live_new_rubric_criteria": "演唱技巧,40\n舞台表现,30\n情感表达,30",
                }
            )
        return data

    def _finish_group_stage(self, stage, *, group_count):
        base, remainder = divmod(len(self.singers), group_count)
        payload: dict[str, object] = {}
        start = 0
        for index in range(1, group_count + 1):
            size = base + (1 if index <= remainder else 0)
            payload[f"group_name_{index}"] = f"第 {index} 组"
            payload[f"group_singer_ids_{index}"] = [
                str(singer.pk) for singer in self.singers[start : start + size]
            ]
            start += size
        self.client.post(reverse("staff:group_stage_record", args=[stage.pk]), payload, follow=True)
        self.client.post(reverse("staff:group_stage_confirm", args=[stage.pk]), follow=True)
        self.client.post(reverse("staff:group_stage_freeze", args=[stage.pk]), follow=True)
        stage.refresh_from_db()

    def test_a_successor_can_replace_the_inherited_grouping(self):
        """The built-in is a starting draft: a running format must not lock its shape in."""

        template = RulesetTemplate.objects.get(builtin_key=LIVE_2026_BUILTIN_KEY)
        self.client.post(
            reverse("staff:ruleset_clone_from_template", args=[template.pk]),
            {"activity": self.activity.pk, "name": "2026 渡梦工作台"},
            follow=True,
        )
        version1 = RulesetVersion.objects.get(ruleset__activity=self.activity)
        page = self.client.get(self._config_url(version1))
        self.client.post(
            self._config_url(version1),
            self._form_data(page, group_count=5, include_first_round=True),
            follow=True,
        )
        self.client.post(self._config_url(version1), {"action": "create_group_stage"}, follow=True)
        stage_a = GroupStage.objects.get(
            activity=self.activity, managed_by=GroupStage.ManagedBy.LIVE_2026
        )
        self._finish_group_stage(stage_a, group_count=5)
        self.client.post(reverse("staff:ruleset_freeze", args=[version1.pk]), follow=True)
        version1.refresh_from_db()
        self.assertEqual(version1.status, RulesetVersion.Status.FROZEN)

        # Successor: the grouping shape changes from 5 groups to 4.
        self.client.post(
            reverse("staff:contest_ruleset_create"),
            {"activity": self.activity.pk, "name": "2026 渡梦工作台（后继）"},
            follow=True,
        )
        version2 = (
            RulesetVersion.objects.filter(
                ruleset__activity=self.activity, status=RulesetVersion.Status.DRAFT
            )
            .order_by("-version")
            .first()
        )
        assert version2 is not None
        page = self.client.get(self._config_url(version2))
        self.client.post(
            self._config_url(version2),
            self._form_data(page, group_count=4),
            follow=True,
        )

        page = self.client.get(self._config_url(version2))
        tasks = {task["key"]: task for task in page.context["tasks"]}
        self.assertFalse(tasks["groups"]["ready"])
        self.assertIsNotNone(page.context["bound_group_stage"])

        first_round_key = str(version2.ruleset.live_challenge.get("podium_first_round_key") or "r1")
        # A generic stage — even one whose key looks like the workbench's — does not
        # replace the inherited binding. Provenance is ``managed_by``, not the key shape.
        generic_stage = create_group_stage(
            self.activity,
            stage_key="generic_chorus",
            name="通用分组",
            operator=self.admin,
        )
        self._finish_group_stage(generic_stage, group_count=4)
        version2.ruleset.refresh_from_db()
        self.assertEqual(version2.ruleset.group_stage_keys[first_round_key], stage_a.pk)

        self.client.post(self._config_url(version2), {"action": "create_group_stage"}, follow=True)
        stage_b = (
            GroupStage.objects.filter(
                activity=self.activity, managed_by=GroupStage.ManagedBy.LIVE_2026
            )
            .exclude(pk=stage_a.pk)
            .get()
        )
        self._finish_group_stage(stage_b, group_count=4)

        version2.ruleset.refresh_from_db()
        first_round_key = str(version2.ruleset.live_challenge.get("podium_first_round_key") or "r1")
        self.assertEqual(version2.ruleset.group_stage_keys[first_round_key], stage_b.pk)

        page = self.client.get(self._config_url(version2))
        self.assertEqual(page.context["completed_count"], 7)
        self.assertEqual(page.context["remaining_count"], 0)

        self.client.post(reverse("staff:ruleset_freeze", args=[version2.pk]), follow=True)
        version2.refresh_from_db()
        version1.refresh_from_db()
        self.assertEqual(version2.status, RulesetVersion.Status.FROZEN)
        self.assertTrue(version2.is_current)
        self.assertEqual(version2.binding["group_stage_keys"][first_round_key], stage_b.pk)
        self.assertEqual(version1.binding["group_stage_keys"][first_round_key], stage_a.pk)

    def test_repeated_re_adjust_reuses_the_unfinished_stage(self):
        template = RulesetTemplate.objects.get(builtin_key=LIVE_2026_BUILTIN_KEY)
        self.client.post(
            reverse("staff:ruleset_clone_from_template", args=[template.pk]),
            {"activity": self.activity.pk, "name": "2026 分组复用"},
            follow=True,
        )
        version = RulesetVersion.objects.get(ruleset__activity=self.activity)

        self.client.post(self._config_url(version), {"action": "create_group_stage"}, follow=True)
        first = GroupStage.objects.get(
            activity=self.activity, managed_by=GroupStage.ManagedBy.LIVE_2026
        )
        self.client.post(self._config_url(version), {"action": "create_group_stage"}, follow=True)

        stages = list(
            GroupStage.objects.filter(
                activity=self.activity, managed_by=GroupStage.ManagedBy.LIVE_2026
            )
        )
        self.assertEqual(len(stages), 1)
        self.assertEqual(stages[0].pk, first.pk)

    def test_the_reserved_group_key_cannot_be_created_generically(self):
        with self.assertRaisesMessage(ValidationError, "保留"):
            create_group_stage(
                self.activity,
                stage_key=GroupStage.LIVE_2026_KEY_PREFIX,
                name="伪装成工作台分组",
                operator=self.admin,
            )

    def test_a_late_frozen_stage_does_not_overwrite_a_newer_explicit_binding(self):
        """Freezing an older preview must not undo a later explicit choice."""

        template = RulesetTemplate.objects.get(builtin_key=LIVE_2026_BUILTIN_KEY)
        self.client.post(
            reverse("staff:ruleset_clone_from_template", args=[template.pk]),
            {"activity": self.activity.pk, "name": "2026 晚冻结"},
            follow=True,
        )
        version1 = RulesetVersion.objects.get(ruleset__activity=self.activity)
        page = self.client.get(self._config_url(version1))
        self.client.post(
            self._config_url(version1),
            self._form_data(page, group_count=5, include_first_round=True),
            follow=True,
        )
        self.client.post(self._config_url(version1), {"action": "create_group_stage"}, follow=True)
        stage_a = GroupStage.objects.get(
            activity=self.activity, managed_by=GroupStage.ManagedBy.LIVE_2026
        )
        self._finish_group_stage(stage_a, group_count=5)
        self.client.post(reverse("staff:ruleset_freeze", args=[version1.pk]), follow=True)
        version1.refresh_from_db()

        self.client.post(
            reverse("staff:contest_ruleset_create"),
            {"activity": self.activity.pk, "name": "2026 晚冻结（后继）"},
            follow=True,
        )
        version2 = (
            RulesetVersion.objects.filter(
                ruleset__activity=self.activity, status=RulesetVersion.Status.DRAFT
            )
            .order_by("-version")
            .first()
        )
        assert version2 is not None
        first_round_key = str(version2.ruleset.live_challenge.get("podium_first_round_key") or "r1")

        # A starts a re-adjustment preview (B) but has not frozen it yet.
        self.client.post(self._config_url(version2), {"action": "create_group_stage"}, follow=True)
        preview = (
            GroupStage.objects.filter(
                activity=self.activity,
                managed_by=GroupStage.ManagedBy.LIVE_2026,
                managed_by_version=version2,
            )
            .exclude(pk=stage_a.pk)
            .get()
        )

        # B explicitly chooses a different frozen stage C.
        alternate = create_group_stage(
            self.activity,
            stage_key="generic_alternate",
            name="备用分组",
            operator=self.admin,
        )
        self._finish_group_stage(alternate, group_count=5)
        page = self.client.get(self._config_url(version2))
        self.client.post(
            self._config_url(version2),
            {
                "action": "bind_group_stage",
                "group_stage_id": alternate.pk,
                "base_binding": page.context["binding_signature"],
                "base_binding_revision": page.context["binding_revision"],
            },
            follow=True,
        )
        version2.ruleset.refresh_from_db()
        self.assertEqual(version2.ruleset.group_stage_keys[first_round_key], alternate.pk)

        # The older preview freezes later. It must not overwrite C.
        self._finish_group_stage(preview, group_count=5)
        preview.refresh_from_db()
        version2.ruleset.refresh_from_db()
        self.assertEqual(preview.status, GroupStage.Status.FROZEN)
        self.assertEqual(version2.ruleset.group_stage_keys[first_round_key], alternate.pk)

        page = self.client.get(self._config_url(version2))
        ready_ids = {stage.pk for stage in page.context["ready_group_stages"]}
        self.assertIn(preview.pk, ready_ids)

    def test_a_successor_does_not_resume_the_previous_versions_abandoned_stage(self):
        template = RulesetTemplate.objects.get(builtin_key=LIVE_2026_BUILTIN_KEY)
        self.client.post(
            reverse("staff:ruleset_clone_from_template", args=[template.pk]),
            {"activity": self.activity.pk, "name": "2026 分组版本归属"},
            follow=True,
        )
        version1 = RulesetVersion.objects.get(ruleset__activity=self.activity)
        page = self.client.get(self._config_url(version1))
        self.client.post(
            self._config_url(version1),
            self._form_data(page, group_count=5, include_first_round=True),
            follow=True,
        )

        # An unfinished preview owned by v1.
        self.client.post(self._config_url(version1), {"action": "create_group_stage"}, follow=True)
        abandoned = (
            GroupStage.objects.filter(
                activity=self.activity,
                managed_by=GroupStage.ManagedBy.LIVE_2026,
                managed_by_version=version1,
            )
            .order_by("-pk")
            .get()
        )

        # v1 completes with a different, frozen stage and freezes.
        final_stage = create_group_stage(
            self.activity,
            stage_key="generic_ready",
            name="正式分组",
            operator=self.admin,
        )
        self._finish_group_stage(final_stage, group_count=5)
        self.client.post(reverse("staff:ruleset_freeze", args=[version1.pk]), follow=True)
        version1.refresh_from_db()

        self.client.post(
            reverse("staff:contest_ruleset_create"),
            {"activity": self.activity.pk, "name": "2026 分组版本归属（后继）"},
            follow=True,
        )
        version2 = (
            RulesetVersion.objects.filter(
                ruleset__activity=self.activity, status=RulesetVersion.Status.DRAFT
            )
            .order_by("-version")
            .first()
        )
        assert version2 is not None

        self.client.post(self._config_url(version2), {"action": "create_group_stage"}, follow=True)
        successor_stage = GroupStage.objects.get(
            activity=self.activity,
            managed_by=GroupStage.ManagedBy.LIVE_2026,
            managed_by_version=version2,
        )

        abandoned.refresh_from_db()
        self.assertEqual(abandoned.status, GroupStage.Status.DRAFT)
        self.assertNotEqual(successor_stage.pk, abandoned.pk)

    def test_a_stale_explicit_group_bind_is_refused(self):
        template = RulesetTemplate.objects.get(builtin_key=LIVE_2026_BUILTIN_KEY)
        self.client.post(
            reverse("staff:ruleset_clone_from_template", args=[template.pk]),
            {"activity": self.activity.pk, "name": "2026 显式绑定并发"},
            follow=True,
        )
        version = RulesetVersion.objects.get(ruleset__activity=self.activity)
        page = self.client.get(self._config_url(version))
        self.client.post(
            self._config_url(version),
            self._form_data(page, group_count=5, include_first_round=True),
            follow=True,
        )
        self.client.post(self._config_url(version), {"action": "create_group_stage"}, follow=True)
        bound = GroupStage.objects.get(
            activity=self.activity,
            managed_by=GroupStage.ManagedBy.LIVE_2026,
            managed_by_version=version,
        )
        self._finish_group_stage(bound, group_count=5)

        stage_c = create_group_stage(
            self.activity, stage_key="generic_c", name="分组 C", operator=self.admin
        )
        self._finish_group_stage(stage_c, group_count=5)
        stage_d = create_group_stage(
            self.activity, stage_key="generic_d", name="分组 D", operator=self.admin
        )
        self._finish_group_stage(stage_d, group_count=5)

        stale_page = self.client.get(self._config_url(version))
        stale_tokens = {
            "action": "bind_group_stage",
            "base_binding": stale_page.context["binding_signature"],
            "base_binding_revision": stale_page.context["binding_revision"],
        }
        self.client.post(
            self._config_url(version),
            {**stale_tokens, "group_stage_id": stage_c.pk},
            follow=True,
        )
        version.ruleset.refresh_from_db()
        key = str(version.ruleset.live_challenge.get("podium_first_round_key") or "r1")
        self.assertEqual(version.ruleset.group_stage_keys[key], stage_c.pk)

        # The second staff member's page still carries the pre-C token.
        response = self.client.post(
            self._config_url(version),
            {**stale_tokens, "group_stage_id": stage_d.pk},
            follow=True,
        )

        self.assertContains(response, "已被其他编辑修改")
        version.ruleset.refresh_from_db()
        self.assertEqual(version.ruleset.group_stage_keys[key], stage_c.pk)

    def test_auto_bind_uses_the_group_stage_binding_revision_so_a_c_a_is_not_mistaken_for_no_change(
        self,
    ):
        template = RulesetTemplate.objects.get(builtin_key=LIVE_2026_BUILTIN_KEY)
        self.client.post(
            reverse("staff:ruleset_clone_from_template", args=[template.pk]),
            {"activity": self.activity.pk, "name": "2026 ABA"},
            follow=True,
        )
        version1 = RulesetVersion.objects.get(ruleset__activity=self.activity)
        page = self.client.get(self._config_url(version1))
        self.client.post(
            self._config_url(version1),
            self._form_data(page, group_count=5, include_first_round=True),
            follow=True,
        )
        self.client.post(self._config_url(version1), {"action": "create_group_stage"}, follow=True)
        stage_a = GroupStage.objects.get(
            activity=self.activity,
            managed_by=GroupStage.ManagedBy.LIVE_2026,
            managed_by_version=version1,
        )
        self._finish_group_stage(stage_a, group_count=5)
        self.client.post(reverse("staff:ruleset_freeze", args=[version1.pk]), follow=True)
        version1.refresh_from_db()

        self.client.post(
            reverse("staff:contest_ruleset_create"),
            {"activity": self.activity.pk, "name": "2026 ABA（后继）"},
            follow=True,
        )
        version2 = (
            RulesetVersion.objects.filter(
                ruleset__activity=self.activity, status=RulesetVersion.Status.DRAFT
            )
            .order_by("-version")
            .first()
        )
        assert version2 is not None
        key = str(version2.ruleset.live_challenge.get("podium_first_round_key") or "r1")

        # The preview records A and the revision at that moment.
        self.client.post(self._config_url(version2), {"action": "create_group_stage"}, follow=True)
        preview = (
            GroupStage.objects.filter(
                activity=self.activity,
                managed_by=GroupStage.ManagedBy.LIVE_2026,
                managed_by_version=version2,
            )
            .order_by("-pk")
            .get()
        )

        stage_c = create_group_stage(
            self.activity, stage_key="generic_aba_c", name="分组 C", operator=self.admin
        )
        self._finish_group_stage(stage_c, group_count=5)

        page = self.client.get(self._config_url(version2))
        self.client.post(
            self._config_url(version2),
            {
                "action": "bind_group_stage",
                "group_stage_id": stage_c.pk,
                "base_binding": page.context["binding_signature"],
                "base_binding_revision": page.context["binding_revision"],
            },
            follow=True,
        )
        page = self.client.get(self._config_url(version2))
        self.client.post(
            self._config_url(version2),
            {
                "action": "bind_group_stage",
                "group_stage_id": stage_a.pk,
                "base_binding": page.context["binding_signature"],
                "base_binding_revision": page.context["binding_revision"],
            },
            follow=True,
        )
        version2.ruleset.refresh_from_db()
        self.assertEqual(version2.ruleset.group_stage_keys[key], stage_a.pk)

        # A -> C -> A looks unchanged to a value-only CAS; the scoped revision is not the
        # same, so the preview's freeze must not take the draft back to A.
        self._finish_group_stage(preview, group_count=5)
        version2.ruleset.refresh_from_db()
        preview.refresh_from_db()
        self.assertEqual(preview.status, GroupStage.Status.FROZEN)
        self.assertEqual(version2.ruleset.group_stage_keys[key], stage_a.pk)


    def _ruleset_version_for(self, activity, name):
        ruleset = ContestRuleset.objects.create(activity=activity, name=name, is_test_data=True)
        with authority_write(RULESET_FREEZE):
            version = RulesetVersion.objects.create(
                ruleset=ruleset,
                version=1,
                definition=json.dumps(
                    {"schema_version": 1, "nodes": [{"key": "roster", "type": "ROSTER"}]}
                ),
                status=RulesetVersion.Status.DRAFT,
                is_current=False,
            )
        return version

    def _foreign_activity_and_version(self):
        with authority_write(ACTIVITY_STATE):
            other = Activity.objects.create(
                title="另一个歌手比赛",
                activity_type=Activity.Type.SINGER_CONTEST,
                phase=Activity.Phase.TESTING,
                is_test_mode=True,
            )
        return other, self._ruleset_version_for(other, "其他赛制")

    def test_an_unrelated_binding_save_does_not_invalidate_a_grouping_preview(self):
        template = RulesetTemplate.objects.get(builtin_key=LIVE_2026_BUILTIN_KEY)
        self.client.post(
            reverse("staff:ruleset_clone_from_template", args=[template.pk]),
            {"activity": self.activity.pk, "name": "2026 无关保存"},
            follow=True,
        )
        version1 = RulesetVersion.objects.get(ruleset__activity=self.activity)
        page = self.client.get(self._config_url(version1))
        self.client.post(
            self._config_url(version1),
            self._form_data(page, group_count=5, include_first_round=True),
            follow=True,
        )
        self.client.post(self._config_url(version1), {"action": "create_group_stage"}, follow=True)
        stage_a = GroupStage.objects.get(
            activity=self.activity,
            managed_by=GroupStage.ManagedBy.LIVE_2026,
            managed_by_version=version1,
        )
        self._finish_group_stage(stage_a, group_count=5)
        self.client.post(reverse("staff:ruleset_freeze", args=[version1.pk]), follow=True)
        version1.refresh_from_db()

        self.client.post(
            reverse("staff:contest_ruleset_create"),
            {"activity": self.activity.pk, "name": "2026 无关保存（后继）"},
            follow=True,
        )
        version2 = (
            RulesetVersion.objects.filter(
                ruleset__activity=self.activity, status=RulesetVersion.Status.DRAFT
            )
            .order_by("-version")
            .first()
        )
        assert version2 is not None
        key = str(version2.ruleset.live_challenge.get("podium_first_round_key") or "r1")

        # A re-adjustment preview records the grouping intent.
        self.client.post(self._config_url(version2), {"action": "create_group_stage"}, follow=True)
        preview = (
            GroupStage.objects.filter(
                activity=self.activity,
                managed_by=GroupStage.ManagedBy.LIVE_2026,
                managed_by_version=version2,
            )
            .order_by("-pk")
            .get()
        )
        version2.ruleset.refresh_from_db()
        group_revision_at_preview = version2.ruleset.group_stage_binding_revision
        binding_revision_at_preview = version2.ruleset.binding_revision

        # Another staff member saves a weight. The binding write is real, but it does not
        # touch the grouping.
        page = self.client.get(self._config_url(version2))
        data = self._form_data(page, group_count=5)
        data["live_first_weight"] = "35"
        data["live_challenge_weight"] = "65"
        self.client.post(self._config_url(version2), data, follow=True)

        version2.ruleset.refresh_from_db()
        self.assertGreater(version2.ruleset.binding_revision, binding_revision_at_preview)
        self.assertEqual(
            version2.ruleset.group_stage_binding_revision, group_revision_at_preview
        )

        # The preview's freeze still knows no grouping intent changed, so it auto-binds.
        self._finish_group_stage(preview, group_count=5)
        version2.ruleset.refresh_from_db()
        self.assertEqual(version2.ruleset.group_stage_keys[key], preview.pk)

    def test_live_2026_group_stage_requires_an_owner_version(self):
        with self.assertRaisesRegex(ValidationError, "必须记录所属赛制版本"):
            create_group_stage(
                self.activity,
                stage_key=GroupStage.LIVE_2026_KEY_PREFIX,
                name="没有归属的分组",
                operator=self.admin,
                managed_by=GroupStage.ManagedBy.LIVE_2026,
            )

    def test_live_2026_group_stage_refuses_a_version_from_another_activity(self):
        _other, foreign_version = self._foreign_activity_and_version()

        with self.assertRaisesRegex(ValidationError, "不属于当前活动"):
            create_group_stage(
                self.activity,
                stage_key=GroupStage.LIVE_2026_KEY_PREFIX,
                name="借来的归属",
                operator=self.admin,
                managed_by=GroupStage.ManagedBy.LIVE_2026,
                managed_by_version=foreign_version,
            )

    def test_a_replacement_group_stage_must_belong_to_the_same_activity(self):
        other, _foreign_version = self._foreign_activity_and_version()
        owner_version = self._ruleset_version_for(self.activity, "当前活动赛制")
        foreign_stage = create_group_stage(
            other, stage_key="foreign_generic", name="外部通用分组", operator=self.admin
        )

        with self.assertRaisesRegex(ValidationError, "被替换的分组不属于当前活动"):
            create_group_stage(
                self.activity,
                stage_key=GroupStage.LIVE_2026_KEY_PREFIX,
                name="跨活动替换",
                operator=self.admin,
                managed_by=GroupStage.ManagedBy.LIVE_2026,
                managed_by_version=owner_version,
                replaces_group_stage=foreign_stage,
            )

    def test_a_generic_group_stage_cannot_declare_an_owner_version(self):
        owner_version = self._ruleset_version_for(self.activity, "当前活动赛制")

        with self.assertRaisesRegex(ValidationError, "通用分组不能声明"):
            create_group_stage(
                self.activity,
                stage_key="generic_owned",
                name="通用分组",
                operator=self.admin,
                managed_by_version=owner_version,
            )


@postgresql_only
class Live2026GroupStageCreationRaceTests(TransactionTestCase):
    """Two staff creating the workbench grouping at once share one stage, never a 500."""

    reset_sequences = True

    def setUp(self):
        with authority_write(ACCOUNT_AUTHORITY):
            self.staff = User.objects.create_user(
                username="workbench-race-staff", password="pass", role=User.Role.STAFF
            )
        with authority_write(ACTIVITY_STATE):
            self.activity = Activity.objects.create(
                title="工作台分组并发",
                activity_type=Activity.Type.SINGER_CONTEST,
                phase=Activity.Phase.TESTING,
                is_test_mode=True,
            )
        ruleset = ContestRuleset.objects.create(
            activity=self.activity, name="2026 并发", is_test_data=True
        )
        ruleset.live_challenge = {"format_key": "2026_live_challenge"}
        ruleset.save(update_fields=["live_challenge"])
        with authority_write(RULESET_FREEZE):
            self.version = RulesetVersion.objects.create(
                ruleset=ruleset,
                version=1,
                definition=json.dumps(
                    {"schema_version": 1, "nodes": [{"key": "roster", "type": "ROSTER"}]}
                ),
                status=RulesetVersion.Status.DRAFT,
                is_current=False,
            )

    def test_two_creators_share_the_unfinished_stage(self):
        barrier = threading.Barrier(2)
        results: list[int] = []
        errors: list[Exception] = []

        def target():
            try:
                barrier.wait(timeout=10)
                version = RulesetVersion.objects.get(pk=self.version.pk)
                results.append(create_live_2026_group_stage(version, operator=self.staff).pk)
            except Exception as error:  # noqa: BLE001 - the assertion is about which error
                errors.append(error)
            finally:
                connection.close()

        threads = [threading.Thread(target=target) for _ in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=20)

        for thread in threads:
            self.assertFalse(thread.is_alive(), "a creator never finished")
        self.assertEqual(errors, [])
        self.assertEqual(len(results), 2)
        self.assertEqual(len(set(results)), 1)
        self.assertEqual(
            GroupStage.objects.filter(
                activity=self.activity, managed_by=GroupStage.ManagedBy.LIVE_2026
            ).count(),
            1,
        )
