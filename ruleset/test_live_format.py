"""The 2026 live challenge as a system built-in (advices §七/§八).

The format's *shape* is enforced at freeze by the live contract; what these tests cover is
that it arrives pre-filled: the built-in template ships with the service, and creating a
ruleset from it provisions the first round and the platform-owned binding keys while
leaving the four operator items — both weight pairs and both judge lists — empty.
"""

import json

from accounts.models import User
from common.authority import (
    ACCOUNT_AUTHORITY,
    ACTIVITY_STATE,
    CONTEST_ROUND_STATE,
    RULESET_FREEZE,
    authority_write,
)
from core.models import Activity
from core.services import transition_activity_phase
from django.core.exceptions import ValidationError
from django.test import TestCase
from questionnaire.compiler import compile_questionnaire
from singer_contest.materials import validate_live_material_plan
from singer_contest.models import ContestRound

from ruleset.live_format import (
    is_live_2026_template,
    live_2026_binding_preset,
    live_challenge_counts_from_binding,
    provision_live_2026_ruleset,
)
from ruleset.models import ContestRuleset, RulesetTemplate, RulesetVersion
from ruleset.schema import parse_definition
from ruleset.services import (
    LIVE_CHALLENGE_FORMAT_KEY,
    _snapshot_binding,
    validate_binding,
)
from ruleset.templates import (
    LIVE_2026_BUILTIN_KEY,
    LIVE_2026_DEFAULTS,
    LIVE_2026_DEFINITION,
    LIVE_2026_FIRST_ROUND_KEY,
    LIVE_2026_TEMPLATE_NAME,
    seed_ruleset_templates,
)

OPERATOR_ONLY_KEYS = (
    "first_round_weight",
    "challenge_round_weight",
    "podium_first_round_weight",
    "podium_third_round_weight",
    "challenge_judge_ids",
    "challenge_minimum_judge_count",
    "final_judge_ids",
    "final_minimum_judge_count",
)


class Live2026BuiltinTests(TestCase):
    def setUp(self):
        with authority_write(ACCOUNT_AUTHORITY):
            self.admin = User.objects.create_user(
                username="builtin-live-admin", password="pass", role=User.Role.ADMIN
            )
        with authority_write(ACTIVITY_STATE):
            self.activity = Activity.objects.create(
                title="2026 院十佳内置赛制",
                activity_type=Activity.Type.SINGER_CONTEST,
                is_test_mode=True,
            )
        transition_activity_phase(self.activity, Activity.Phase.TESTING, actor=self.admin)
        seed_ruleset_templates(None)
        self.template = RulesetTemplate.objects.get(builtin_key=LIVE_2026_BUILTIN_KEY)

    def _provision(self, name="2026 院十佳现场赛制"):
        return provision_live_2026_ruleset(
            self.activity, template=self.template, name=name, operator=self.admin
        )

    def test_counts_read_from_a_binding_and_default_the_grouping(self):
        """Bindings frozen before grouping was a parameter still resolve, at the 5x3 default."""

        counts = live_challenge_counts_from_binding(
            {
                "live_challenge": {
                    "format_key": LIVE_CHALLENGE_FORMAT_KEY,
                    "participant_count": 15,
                    "seat_count": 10,
                    "challenge_count": 5,
                }
            }
        )

        self.assertEqual(counts.participant_count, 15)
        self.assertEqual(counts.seat_count, 10)
        self.assertEqual(counts.group_count, 5)
        self.assertEqual(counts.group_size, 3)
        self.assertEqual(counts.challenge_count, 5)

    def test_challenge_count_is_derived_not_read(self):
        """A stored mirror that disagrees loses: the arithmetic is the definition."""

        counts = live_challenge_counts_from_binding(
            {"live_challenge": {"participant_count": 12, "seat_count": 8, "challenge_count": 99}}
        )

        self.assertEqual(counts.challenge_count, 4)

    def test_counts_follow_the_current_authority_not_any_frozen_row(self):
        """A superseded version stays ``FROZEN`` forever, so resolution must not scan them.

        Both versions can bind the same physical round; serving the older one's numbers would
        silently disagree with the group stage, which does resolve through the current
        authority.
        """

        from singer_contest.models import ContestRound

        from ruleset.live_format import live_challenge_counts_for_round as resolve
        from ruleset.templates import LIVE_2026_FIRST_ROUND_KEY

        with authority_write(CONTEST_ROUND_STATE):
            contest_round = ContestRound.objects.create(
                activity=self.activity,
                round_type=ContestRound.RoundType.PRELIMINARY,
                name="第一轮",
                sequence=1,
            )
        ruleset = ContestRuleset.objects.create(
            activity=self.activity, name="2026 现场赛制", is_test_data=True
        )
        ruleset.round_keys = {LIVE_2026_FIRST_ROUND_KEY: contest_round.pk}
        ruleset.save(update_fields=["round_keys"])

        def _frozen(version_number, seat_count, *, current):
            # The guard manager reserves FROZEN/current rows for the freeze service; this test
            # only needs the rows to exist, so it takes the same authority that service does.
            with authority_write(RULESET_FREEZE):
                return RulesetVersion.objects.create(
                    ruleset=ruleset,
                    version=version_number,
                    status=RulesetVersion.Status.FROZEN,
                    is_current=current,
                    definition=(
                        '{"schema_version": 1, "nodes": [{"key": "roster", "type": "ROSTER"}]}'
                    ),
                    binding={
                        "round_keys": {LIVE_2026_FIRST_ROUND_KEY: contest_round.pk},
                        "live_challenge": {
                            "format_key": LIVE_CHALLENGE_FORMAT_KEY,
                            "participant_count": 15,
                            "seat_count": seat_count,
                            "challenge_count": 15 - seat_count,
                        },
                    },
                )

        superseded = _frozen(1, 10, current=False)
        current = _frozen(2, 8, current=True)

        self.assertEqual(resolve(contest_round).seat_count, 8)
        # A historical replay names its version rather than guessing from the round.
        self.assertEqual(resolve(contest_round, version=superseded).seat_count, 10)
        self.assertEqual(resolve(contest_round, version=current).seat_count, 8)

    def test_builtin_ships_with_the_service(self):
        self.assertEqual(self.template.name, LIVE_2026_TEMPLATE_NAME)
        self.assertEqual(
            self.template.capability_status, RulesetTemplate.CapabilityStatus.PRODUCTION
        )
        self.assertTrue(self.template.is_available)
        self.assertTrue(self.template.content_hash)
        self.assertTrue(is_live_2026_template(self.template))
        self.assertFalse(is_live_2026_template(None))

    def test_builtin_definition_is_the_2026_shape(self):
        parsed = parse_definition(LIVE_2026_DEFINITION)
        self.assertEqual(parsed["schema_version"], 1)
        nodes = {node["key"]: node for node in parsed["nodes"]}
        self.assertEqual(nodes["assess_r1"]["round"], LIVE_2026_FIRST_ROUND_KEY)
        self.assertEqual(nodes["top10"]["type"], "SELECT")
        self.assertEqual(nodes["top10"]["count"], LIVE_2026_DEFAULTS["seat_count"])

        # The material contract the format requires: R2 and R3 songs plus accompaniments,
        # both required for every entrant — including those who never reach those rounds.
        section = json.loads(LIVE_2026_DEFINITION)["questionnaire"]
        plan = compile_questionnaire(section)
        validate_live_material_plan(plan)

    def test_preset_carries_only_platform_invariants(self):
        preset = live_2026_binding_preset()
        self.assertEqual(preset["format_key"], LIVE_CHALLENGE_FORMAT_KEY)
        for key, value in LIVE_2026_DEFAULTS.items():
            self.assertEqual(preset[key], value)
        for key in (
            "podium_stage_key",
            "podium_first_round_key",
            "podium_third_round_key",
            "podium_aggregate_node",
        ):
            self.assertTrue(preset[key])
        # The operators' items must never be pre-filled: the format document leaves both
        # ratio pairs undecided and forbids picking one in their place.
        for key in OPERATOR_ONLY_KEYS:
            self.assertNotIn(key, preset)

    def test_provisioning_creates_the_round_version_and_binding(self):
        version = self._provision()

        ruleset = ContestRuleset.objects.get(activity=self.activity)
        self.assertEqual(ruleset.source_template, self.template)
        self.assertEqual(ruleset.versions.count(), 1)
        self.assertEqual(version.status, RulesetVersion.Status.DRAFT)
        self.assertEqual(version.definition, self.template.definition)

        contest_round = ContestRound.objects.get(activity=self.activity)
        self.assertEqual(contest_round.name, "第一轮")
        self.assertEqual(contest_round.advance_count, LIVE_2026_DEFAULTS["seat_count"])
        self.assertEqual(
            contest_round.score_completion_mode, ContestRound.CompletionMode.MINIMUM_VALID
        )
        self.assertEqual(contest_round.scoring_mode, ContestRound.ScoringMode.AVERAGE)
        self.assertEqual(contest_round.roster_source, ContestRound.RosterSource.APPROVED)
        # The operator's to fill: the freeze contract refuses until these exist.
        self.assertIsNone(contest_round.judge_count)
        self.assertIsNone(contest_round.minimum_judge_count)
        self.assertIsNone(contest_round.rubric)

        self.assertEqual(ruleset.round_keys, {LIVE_2026_FIRST_ROUND_KEY: contest_round.pk})
        live = ruleset.live_challenge
        self.assertEqual(live["format_key"], LIVE_CHALLENGE_FORMAT_KEY)
        self.assertEqual(live["participant_count"], LIVE_2026_DEFAULTS["participant_count"])
        for key in OPERATOR_ONLY_KEYS:
            self.assertNotIn(key, live)

        # The version's own binding stays empty: the freeze snapshot reads the ruleset.
        self.assertEqual(version.binding, {})

    def test_provisioned_binding_saves_but_cannot_freeze_yet(self):
        self._provision()
        ruleset = ContestRuleset.objects.get(activity=self.activity)
        binding = _snapshot_binding(ruleset)
        # Saving the incomplete draft is allowed...
        self.assertEqual(validate_binding(ruleset, binding)["live_challenge"]["seat_count"], 10)
        # ...and freeze rejects it until the operators' ratios exist.
        with self.assertRaisesMessage(ValidationError, "踢馆成绩权重必须合计 100%"):
            validate_binding(ruleset, binding, require_live_challenge_complete=True)

    def test_provisioning_reuses_the_round_and_keeps_other_binding_keys(self):
        self._provision()
        ruleset = ContestRuleset.objects.get(activity=self.activity)
        first_round_pk = ruleset.round_keys[LIVE_2026_FIRST_ROUND_KEY]
        ruleset.announcement_blocks = [{"key": "opening", "title": "开场"}]
        ruleset.save(update_fields=["announcement_blocks"])

        self._provision(name="再次进入编辑")

        ruleset.refresh_from_db()
        self.assertEqual(ContestRound.objects.filter(activity=self.activity).count(), 1)
        self.assertEqual(ruleset.round_keys[LIVE_2026_FIRST_ROUND_KEY], first_round_pk)
        self.assertEqual(ruleset.announcement_blocks, [{"key": "opening", "title": "开场"}])
        self.assertEqual(ruleset.versions.count(), 2)
