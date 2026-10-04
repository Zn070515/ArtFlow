from accounts.models import User
from common.authority import ACCOUNT_AUTHORITY, ACTIVITY_STATE, RULESET_FREEZE, authority_write
from core.models import Activity
from django.core.exceptions import ValidationError
from django.test import TestCase
from singer_contest.group_chorus import (
    confirm_group_stage,
    create_group_stage,
    freeze_group_stage,
    record_group_stage,
)
from singer_contest.models import SingerRegistration
from singer_contest.services import _source_group_of

from ruleset.models import ContestRuleset, RulesetVersion
from ruleset.services import validate_binding


class GroupChorusRulesetIntegrationTests(TestCase):
    def setUp(self):
        with authority_write(ACCOUNT_AUTHORITY):
            self.operator = User.objects.create_user(
                username="group-ruleset-admin", password="pass", role=User.Role.ADMIN
            )
        with authority_write(ACTIVITY_STATE):
            self.activity = Activity.objects.create(
                title="Group ruleset",
                activity_type=Activity.Type.SINGER_CONTEST,
                phase=Activity.Phase.REGISTRATION_OPEN,
                is_test_mode=True,
            )
        self.singers = []
        for index in range(2):
            with authority_write(ACCOUNT_AUTHORITY):
                user = User.objects.create_user(
                    username=f"group-ruleset-singer-{index}", password="pass"
                )
            self.singers.append(
                SingerRegistration.objects.create(
                    activity=self.activity,
                    user=user,
                    name=f"Singer {index}",
                    student_id=f"GR{index}",
                    college="Arts",
                    class_name="1",
                    phone=f"1390000000{index}",
                    pre_status=SingerRegistration.PreStatus.APPROVED,
                    is_test_data=True,
                )
            )
        self.ruleset = ContestRuleset.objects.create(
            activity=self.activity,
            name="Group ruleset",
            is_test_data=True,
        )

    def _frozen_stage(self):
        stage = create_group_stage(
            self.activity,
            stage_key="chorus-frozen",
            name="Chorus",
            operator=self.operator,
        )
        record_group_stage(
            stage,
            [
                {"name": "A", "singer_ids": [self.singers[0].pk]},
                {"name": "B", "singer_ids": [self.singers[1].pk]},
            ],
            self.operator,
        )
        confirm_group_stage(stage, self.operator)
        return freeze_group_stage(stage, self.operator)

    def test_binding_requires_a_frozen_same_activity_group_stage(self):
        stage = create_group_stage(
            self.activity,
            stage_key="chorus",
            name="Chorus",
            operator=self.operator,
        )
        with self.assertRaises(ValidationError):
            validate_binding(
                self.ruleset,
                {"group_stage_keys": {"chorus": stage.pk}},
            )

        frozen = self._frozen_stage()
        normalized = validate_binding(
            self.ruleset,
            {"group_stage_keys": {"chorus": frozen.pk}},
        )
        self.assertEqual(normalized["group_stage_keys"], {"chorus": frozen.pk})

    def test_resolver_reads_frozen_group_membership_as_group_of(self):
        frozen = self._frozen_stage()
        resolved = _source_group_of(
            self.activity,
            {"group_stage_keys": {"chorus": frozen.pk}},
        )
        self.assertEqual(
            resolved["chorus"],
            {str(self.singers[0].pk): "A", str(self.singers[1].pk): "B"},
        )

    def test_frozen_ruleset_protects_the_group_membership_snapshot(self):
        frozen = self._frozen_stage()
        version = RulesetVersion.objects.create(
            ruleset=self.ruleset,
            version=1,
            definition='{"schema_version": 1, "nodes": [{"key": "stage", "type": "ROSTER"}]}',
            binding={"group_stage_keys": {"chorus": frozen.pk}},
        )
        with authority_write(RULESET_FREEZE):
            version.status = RulesetVersion.Status.FROZEN
            version.save(update_fields=["status"])

        with self.assertRaisesMessage(ValidationError, "已被冻结赛制使用"):
            from singer_contest.group_chorus import correct_group_stage

            correct_group_stage(
                frozen,
                [
                    {"name": "A", "singer_ids": [self.singers[0].pk]},
                    {"name": "B", "singer_ids": [self.singers[1].pk]},
                ],
                self.operator,
                reason="修改已冻结快照",
            )
