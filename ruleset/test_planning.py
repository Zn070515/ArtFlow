import json
from decimal import Decimal

from accounts.models import User
from common.authority import ACCOUNT_AUTHORITY, ACTIVITY_STATE, RULESET_FREEZE, authority_write
from core.models import Activity
from django.core.exceptions import ValidationError
from django.test import SimpleTestCase, TestCase

from ruleset.models import ContestRuleset, RulesetPlanningDraft, RulesetVersion
from ruleset.planning import (
    default_planning_payload,
    PlanningResolution,
    PlanningSeverity,
    parse_percentage,
    planning_field,
    validate_planning_draft,
)


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

