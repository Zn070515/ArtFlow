"""§5.2 / §5.3 — the VoteScoringRule conversion authority.

A conversion rule is formal authority: it decides what a ballot batch *means* as a score.
So it may only be configured through the audited service, never by a bare ORM write, and it
freezes once the session opens, locks, or is consumed by a frozen ruleset version. Changing
the conversion after that requires a new rule / new ruleset version and a new freeze — not
an in-place edit of historical authority.
"""

from datetime import timedelta

from accounts.models import User
from common.authority import ACCOUNT_AUTHORITY, RULESET_FREEZE, authority_write
from common.models import AuditLog
from core.models import Activity
from django.core.exceptions import ValidationError
from django.test import TestCase
from django.utils import timezone
from ruleset.models import ContestRuleset, RulesetVersion

from .models import VoteScoringRule, VoteSession
from .services import configure_vote_scoring_rule, lock_vote_session, open_vote_session

MODE = VoteScoringRule.Mode.BALLOT_SHARE_PERCENT


class VoteScoringRuleAuthorityTests(TestCase):
    def setUp(self):
        self.activity = Activity.objects.create(
            title="Vote scoring rule",
            activity_type=Activity.Type.SINGER_CONTEST,
            is_test_mode=True,
        )
        with authority_write(ACCOUNT_AUTHORITY):
            self.staff = User.objects.create_user(
                username="vote-scoring-staff", password="pass", role=User.Role.STAFF
            )
        self.session = VoteSession.objects.create(
            activity=self.activity,
            name="成绩投票",
            passcode="0000",
            start_time=timezone.now() - timedelta(minutes=1),
            end_time=timezone.now() + timedelta(hours=1),
            purpose=VoteSession.Purpose.SCORE_COMPONENT,
            requires_ticket=True,
            is_test_data=True,
        )

    def _session(self, **overrides):
        values = {
            "activity": self.activity,
            "name": "成绩投票",
            "passcode": "9999",
            "start_time": timezone.now() - timedelta(minutes=1),
            "end_time": timezone.now() + timedelta(hours=1),
            "purpose": VoteSession.Purpose.SCORE_COMPONENT,
            "requires_ticket": True,
            "is_test_data": True,
        }
        values.update(overrides)
        return VoteSession.objects.create(**values)

    def test_score_component_is_a_declared_vote_purpose(self):
        self.assertEqual(VoteSession.Purpose.SCORE_COMPONENT.value, "score_component")
        self.assertIn("score_component", VoteSession.Purpose.values)

    def test_service_configures_the_ballot_share_conversion(self):
        rule = configure_vote_scoring_rule(self.session, self.staff)
        rule.refresh_from_db()
        self.assertEqual(rule.vote_session_id, self.session.pk)
        self.assertEqual(rule.mode, VoteScoringRule.Mode.BALLOT_SHARE_PERCENT)
        self.assertEqual(rule.output_scale, "hundred")
        self.assertTrue(
            AuditLog.objects.filter(
                action_type=AuditLog.ActionType.VOTE_MANAGE,
                target=f"VoteSession:{self.session.pk}",
            ).exists()
        )

    def test_service_configuration_is_idempotent(self):
        first = configure_vote_scoring_rule(self.session, self.staff)
        second = configure_vote_scoring_rule(self.session, self.staff)
        self.assertEqual(first.pk, second.pk)
        self.assertEqual(VoteScoringRule.objects.filter(vote_session=self.session).count(), 1)

    def test_service_refuses_a_non_score_component_session(self):
        session = self._session(purpose=VoteSession.Purpose.POPULARITY)
        with self.assertRaises(ValidationError):
            configure_vote_scoring_rule(session, self.staff)
        self.assertFalse(VoteScoringRule.objects.filter(vote_session=session).exists())

    def test_service_refuses_a_session_without_ticket_checking(self):
        session = self._session(requires_ticket=False)
        with self.assertRaises(ValidationError):
            configure_vote_scoring_rule(session, self.staff)
        self.assertFalse(VoteScoringRule.objects.filter(vote_session=session).exists())

    def test_bare_orm_create_is_refused(self):
        with self.assertRaises(ValidationError):
            VoteScoringRule.objects.create(vote_session=self.session, mode=MODE)
        with self.assertRaises(ValidationError):
            VoteScoringRule.objects.bulk_create([VoteScoringRule(vote_session=self.session)])

    def test_queryset_mutations_are_refused(self):
        rule = configure_vote_scoring_rule(self.session, self.staff)
        with self.assertRaises(ValidationError):
            VoteScoringRule.objects.filter(pk=rule.pk).update(mode=MODE)
        with self.assertRaises(ValidationError):
            VoteScoringRule.objects.filter(pk=rule.pk).delete()
        with self.assertRaises(ValidationError):
            rule.delete()

    def test_instance_save_outside_the_service_is_refused(self):
        rule = configure_vote_scoring_rule(self.session, self.staff)
        rule.output_scale = "ten"
        with self.assertRaises(ValidationError):
            rule.save()
        rule.refresh_from_db()
        self.assertEqual(rule.output_scale, "hundred")

    def test_conversion_cannot_change_after_the_session_opens(self):
        configure_vote_scoring_rule(self.session, self.staff)
        open_vote_session(self.session, self.staff)
        with self.assertRaises(ValidationError):
            configure_vote_scoring_rule(self.session, self.staff)

    def test_conversion_cannot_change_after_the_session_locks(self):
        configure_vote_scoring_rule(self.session, self.staff)
        lock_vote_session(self.session, self.staff)
        with self.assertRaises(ValidationError):
            configure_vote_scoring_rule(self.session, self.staff)

    def test_test_data_cleanup_removes_the_rule_with_its_session(self):
        # Clearing rehearsable TEST data must stay possible with a conversion rule present:
        # the rule is not a protected formal fact, it goes away with its session.
        from common.test_data import clear_activity_test_data

        rule = configure_vote_scoring_rule(self.session, self.staff)
        session_pk, rule_pk = self.session.pk, rule.pk

        clear_activity_test_data(self.activity, operator=self.staff)

        self.assertFalse(VoteScoringRule.objects.filter(pk=rule_pk).exists())
        self.assertFalse(VoteSession.objects.filter(pk=session_pk).exists())

    def test_conversion_cannot_change_after_a_frozen_ruleset_consumed_it(self):
        configure_vote_scoring_rule(self.session, self.staff)
        ruleset = ContestRuleset.objects.create(
            activity=self.activity, name="RS", is_test_data=True
        )
        with authority_write(RULESET_FREEZE):
            RulesetVersion.objects.create(
                ruleset=ruleset,
                version=1,
                definition='{"schema_version": 1, "nodes": [{"key": "roster", "type": "ROSTER"}]}',
                status=RulesetVersion.Status.FROZEN,
                is_current=True,
                binding={"vote_keys": {"audience1": self.session.pk}},
            )
        with self.assertRaises(ValidationError):
            configure_vote_scoring_rule(self.session, self.staff)
