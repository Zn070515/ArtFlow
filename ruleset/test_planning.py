import json
from decimal import Decimal

from accounts.models import User
from common.authority import ACCOUNT_AUTHORITY, ACTIVITY_STATE, RULESET_FREEZE, authority_write
from common.models import AuditLog
from core.models import Activity
from django.core.exceptions import ValidationError
from django.test import SimpleTestCase, TestCase

from singer_contest.models import ContestRound

from ruleset.models import ContestRuleset, RulesetPlanningDraft, RulesetVersion
from ruleset.planning import (
    default_planning_payload,
    PlanningResolution,
    PlanningSeverity,
    parse_percentage,
    planning_field,
    validate_planning_draft,
)
from ruleset.services import load_planning_draft, planning_projection_from_definition, save_planning_draft
from ruleset.templates import golden_schidui


class PercentageParsingTests(SimpleTestCase):
    def test_plain_number_is_percentage_not_coefficient(self):
        parsed = parse_percentage("50")

        self.assertEqual(parsed.percent, Decimal("50"))
        self.assertEqual(parsed.coefficient, Decimal("0.5"))
        self.assertFalse(parsed.requires_confirmation)
        self.assertFalse(parsed.had_percent_sign)

    def test_percent_suffix_keeps_percentage_meaning(self):
        parsed = parse_percentage("50%")

        self.assertEqual(parsed.percent, Decimal("50"))
        self.assertEqual(parsed.coefficient, Decimal("0.5"))
        self.assertTrue(parsed.had_percent_sign)

    def test_fraction_without_suffix_requires_confirmation(self):
        parsed = parse_percentage("0.5")

        self.assertEqual(parsed.percent, Decimal("0.5"))
        self.assertEqual(parsed.coefficient, Decimal("0.005"))
        self.assertTrue(parsed.requires_confirmation)

    def test_invalid_percentage_values_are_rejected(self):
        for value in ("-1", "100.01", "NaN", "Infinity", "50%%"):
            with self.subTest(value=value):
                with self.assertRaises(ValidationError):
                    parse_percentage(value)


class PlanningValidationTests(SimpleTestCase):
    def test_missing_participant_count_is_saveable_but_blocks_apply(self):
        payload = {
            "schema_version": 1,
            "stages": [
                {
                    "business_id": "stage-1",
                    "participants": {"source": "all_finalists", "count": None},
                }
            ],
        }

        issue = next(
            issue
            for issue in validate_planning_draft(payload)
            if issue.code == "MISSING_PARTICIPANT_COUNT"
        )

        self.assertEqual(issue.severity, PlanningSeverity.MISSING_INFORMATION)
        self.assertTrue(issue.blocks_apply)
        self.assertEqual(issue.stage_id, "stage-1")

    def test_confirmed_false_is_not_missing(self):
        value = planning_field(
            False,
            PlanningResolution.CONFIRMED,
            "老师确认不计观众分",
            "score",
        )

        self.assertIs(value["value"], False)

    def test_conflicting_evidence_is_a_business_conflict(self):
        payload = {
            "schema_version": 1,
            "stages": [
                {
                    "business_id": "stage-1",
                    "name": {
                        "value": "初赛",
                        "resolution": "conflict",
                        "evidence": "两份材料分别写 30% 和 40%",
                        "unit": "text",
                    },
                }
            ],
        }

        issues = validate_planning_draft(payload)

        self.assertEqual(issues[0].severity, PlanningSeverity.BUSINESS_CONFLICT)
        self.assertEqual(issues[0].code, "CONFLICTING_EVIDENCE")


class PlanningDraftAuthorityTests(TestCase):
    def setUp(self):
        with authority_write(ACCOUNT_AUTHORITY):
            self.operator = User.objects.create_user(
                username="planning-authority-user",
                password="pass",
                role=User.Role.STAFF,
            )
        with authority_write(ACTIVITY_STATE):
            self.activity = Activity.objects.create(
                title="规划草稿活动",
                activity_type=Activity.Type.SINGER_CONTEST,
                is_test_mode=True,
            )
        self.ruleset = ContestRuleset.objects.create(
            activity=self.activity,
            name="规划草稿规则",
            is_test_data=True,
            created_by=self.operator,
        )
        self.version = RulesetVersion.objects.create(
            ruleset=self.ruleset,
            definition=json.dumps(
                {"schema_version": 1, "nodes": [{"key": "roster", "type": "ROSTER"}]}
            ),
            created_by=self.operator,
        )

    def test_direct_draft_save_is_rejected_outside_planning_service(self):
        draft = RulesetPlanningDraft(
            ruleset_version=self.version,
            payload=default_planning_payload(),
        )

        with self.assertRaises(ValidationError):
            draft.save()

    def test_draft_cannot_attach_to_frozen_version(self):
        self.version.status = RulesetVersion.Status.FROZEN
        with authority_write(RULESET_FREEZE):
            self.version.save(update_fields=["status"])

        with self.assertRaises(ValidationError):
            RulesetPlanningDraft(
                ruleset_version=self.version,
                payload=default_planning_payload(),
            ).full_clean()


class PlanningDraftServiceTests(PlanningDraftAuthorityTests):
    def test_load_initializes_a_blank_draft_without_creating_rounds(self):
        before_rounds = ContestRound.objects.filter(activity=self.activity).count()

        draft = load_planning_draft(self.version)

        self.assertEqual(draft.revision, 0)
        self.assertEqual(draft.payload, default_planning_payload())
        self.assertEqual(draft.source, "manual")
        self.assertEqual(ContestRound.objects.filter(activity=self.activity).count(), before_rounds)

    def test_saving_participant_count_does_not_create_round_or_change_definition(self):
        before_definition = self.version.definition
        before_rounds = ContestRound.objects.filter(activity=self.activity).count()
        payload = {
            "schema_version": 1,
            "stages": [
                {
                    "business_id": "stage-1",
                    "participants": {
                        "source": "all_finalists",
                        "count": planning_field(
                            15,
                            PlanningResolution.CONFIRMED,
                            "报名汇总表",
                            "person",
                        ),
                    },
                }
            ],
        }

        saved = save_planning_draft(
            self.version,
            payload=payload,
            operator=self.operator,
            expected_revision=0,
        )

        self.assertEqual(saved.revision, 1)
        self.version.refresh_from_db()
        self.assertEqual(self.version.definition, before_definition)
        self.assertEqual(ContestRound.objects.filter(activity=self.activity).count(), before_rounds)
        self.assertTrue(
            AuditLog.objects.filter(
                action_type=AuditLog.ActionType.UPDATE_RULESET_PLANNING,
                target=f"RulesetPlanningDraft:{saved.pk}",
            ).exists()
        )

    def test_stale_revision_is_rejected_without_overwriting_payload(self):
        first_payload = {"schema_version": 1, "stages": []}
        second_payload = {
            "schema_version": 1,
            "stages": [{"business_id": "other"}],
        }
        save_planning_draft(
            self.version,
            payload=first_payload,
            operator=self.operator,
            expected_revision=0,
        )

        with self.assertRaises(ValidationError):
            save_planning_draft(
                self.version,
                payload=second_payload,
                operator=self.operator,
                expected_revision=0,
            )

        draft = RulesetPlanningDraft.objects.get(ruleset_version=self.version)
        self.assertEqual(draft.revision, 1)
        self.assertEqual(draft.payload, first_payload)


class PlanningProjectionTests(SimpleTestCase):
    def test_golden_linear_definition_projects_to_editable_business_stages(self):
        projection = planning_projection_from_definition(golden_schidui())

        self.assertTrue(projection.editable)
        self.assertFalse(projection.read_only)
        self.assertEqual(
            [stage["advance_count"] for stage in projection.stages],
            [10, 5, 3],
        )
        self.assertEqual(projection.source, "historical_projection")

    def test_complex_definition_is_read_only_and_keeps_manual_node_information(self):
        definition = {
            "schema_version": 1,
            "nodes": [
                {"key": "roster", "type": "ROSTER"},
                {
                    "key": "groups",
                    "type": "PARTITION",
                    "source": "entry",
                    "by": "g",
                },
                {
                    "key": "manual",
                    "type": "MANUAL_SELECT",
                    "source": "groups",
                    "groups": 1,
                    "quota": 3,
                },
            ],
            "checkpoints": [{"key": "final", "output": "manual"}],
        }

        projection = planning_projection_from_definition(definition)

        self.assertFalse(projection.editable)
        self.assertTrue(projection.read_only)
        self.assertIn("人工", projection.notice)

