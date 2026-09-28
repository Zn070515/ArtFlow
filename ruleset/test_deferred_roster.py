"""P0-B — the entry roster is UNKNOWN before registration, not zero.

``build_bound_context`` derives ``entry_size`` from the approved-singer count, and the
bound compiler escalates every "unverifiable" WARN to a hard ERROR. Before registration
opens that count is 0, so a ruleset whose first checkpoint selects ``top10`` reports
``QUOTA_EXCEEDED`` — a false ERROR about a pool that does not exist yet. The product flow
the Questionnaire work needs is the opposite order:

    confirm the ruleset → the frozen ruleset decides the registration form → registration

so ``entry_roster_final`` splits the two validity questions:

- **definition validity** — provable now, so it stays a hard Freeze gate;
- **runtime roster validity** — only provable once the roster exists, so it becomes a
  DEFERRED obligation at Freeze and a fail-closed gate at runtime readiness.

The point is that 0 and unknown are different facts: a freeze may not invent 0, and it may
not pretend the check passed either.
"""

import json
from datetime import timedelta
from uuid import uuid4

from accounts.models import User
from common.authority import ACCOUNT_AUTHORITY, ACTIVITY_STATE, authority_write
from core.models import Activity
from django.core.exceptions import ValidationError
from django.utils import timezone
from singer_contest.models import (
    ContestRound,
    RubricCriterion,
    ScoringRubric,
    SingerRegistration,
)
from voting.models import VoteSession
from voting.services import configure_vote_scoring_rule

from ruleset.compiler import Severity, compile_definition
from ruleset.schema import ENTRY_KEY
from ruleset.services import (
    RulesetInvalidError,
    build_bound_context,
    freeze_ruleset_version,
    validate_ruleset_runtime_readiness,
    vote_scoring_binding_snapshot,
)
from ruleset.test_schema import _RulesetModelBase

from .models import ContestRuleset, RulesetVersion

VOTE_CONVERSION = {"mode": "ballot_share_percent", "scale": "hundred"}


def _definition_15_10_5_3():
    """院十佳 15 → 10 → 5 → 3 over four rounds; the first checkpoint is a top10 SELECT."""
    return json.dumps(
        {
            "schema_version": 1,
            "nodes": [
                {"key": "assess_r1", "type": "ASSESS", "source": ENTRY_KEY, "round": "r1"},
                {"key": "assess_r2", "type": "ASSESS", "source": ENTRY_KEY, "round": "r2"},
                {
                    "key": "stage1",
                    "type": "AGGREGATE",
                    "within": ENTRY_KEY,
                    "aggregate": {
                        "type": "weighted_sum",
                        "components": [
                            {"source": "assess_r1", "weight": 0.4},
                            {"source": "assess_r2", "weight": 0.6},
                        ],
                    },
                },
                {"key": "rank1", "type": "RANK", "source": "stage1", "descending": True},
                {"key": "top10", "type": "SELECT", "source": "rank1", "count": 10},
                {"key": "assess_r3", "type": "ASSESS", "source": "top10", "round": "r3"},
                {
                    "key": "stage2",
                    "type": "AGGREGATE",
                    "within": "top10",
                    "aggregate": {
                        "type": "weighted_sum",
                        "components": [
                            {"source": "stage1", "weight": 0.5},
                            {"source": "assess_r3", "weight": 0.5},
                        ],
                    },
                },
                {"key": "rank2", "type": "RANK", "source": "stage2", "descending": True},
                {"key": "top5", "type": "SELECT", "source": "rank2", "count": 5},
                {"key": "assess_r4", "type": "ASSESS", "source": "top5", "round": "r4"},
                {
                    "key": "final",
                    "type": "AGGREGATE",
                    "within": "top5",
                    "aggregate": {
                        "type": "weighted_sum",
                        "components": [
                            {"source": "assess_r3", "weight": 0.3},
                            {"source": "assess_r4", "weight": 0.7},
                        ],
                    },
                },
                {"key": "rank3", "type": "RANK", "source": "final", "descending": True},
                {"key": "top3", "type": "SELECT", "source": "rank3", "count": 3},
            ],
        },
        ensure_ascii=False,
    )


# Registrations open → the roster does not exist yet. REHEARSAL → it is settled.
OPEN = Activity.Phase.REGISTRATION_OPEN
REVIEWING = Activity.Phase.REVIEWING
SETTLED = Activity.Phase.REHEARSAL


class _DeferredRosterBase(_RulesetModelBase):
    def admin(self):
        cached = getattr(self, "_admin_user", None)
        if cached is not None:
            return cached
        user = self.make_user(f"deferred-admin-{uuid4().hex[:8]}")
        user.role = User.Role.ADMIN
        with authority_write(ACCOUNT_AUTHORITY):
            user.save()
        self._admin_user = user
        return user

    @staticmethod
    def context_for(version, **binding):
        """The real editable binding shape a freeze builds its context from."""
        ruleset = version.ruleset
        merged = {
            "round_keys": ruleset.round_keys,
            "vote_keys": ruleset.vote_keys,
            "audience_keys": ruleset.audience_keys,
            "group_keys": ruleset.group_keys,
            # Freeze snapshots the conversion identity before building the context; mirror
            # that here so a direct build_bound_context() sees the same shape.
            "vote_scoring_rule_keys": vote_scoring_binding_snapshot(ruleset.vote_scoring_rule_keys),
        }
        merged.update(binding)
        return build_bound_context(version, merged)

    def rounds_binding(self, activity, keys=("r1", "r2", "r3", "r4")):
        binding = {}
        for key in keys:
            rubric = ScoringRubric.objects.create(
                activity=activity, name=f"{key}评分", is_test_data=True
            )
            RubricCriterion.objects.create(
                rubric=rubric, name="总分", max_score=100, is_test_data=True
            )
            round_ = ContestRound.objects.create(
                activity=activity,
                round_type=ContestRound.RoundType.PRELIMINARY,
                name=key,
            )
            round_.rubric = rubric
            round_.save(update_fields=["rubric"])
            binding[key] = round_.pk
        return binding

    def bound_ruleset(self, *, phase, title="deferred"):
        activity = self.make_activity(is_test_mode=True, phase=phase, title=title)
        ruleset = ContestRuleset.objects.create(activity=activity, name="RS", is_test_data=True)
        ruleset.round_keys = self.rounds_binding(activity)
        ruleset.save(update_fields=["round_keys"])
        return ruleset

    def approved(self, activity, count, *, offset=100000):
        for i in range(count):
            self.make_singer(
                activity,
                username=f"deferred-{activity.pk}-{i}",
                student_id=str(offset + i),
                pre_status=SingerRegistration.PreStatus.APPROVED,
                is_test_data=True,
            )

    def version(self, ruleset, definition=None):
        return RulesetVersion.objects.create(
            ruleset=ruleset,
            definition=definition or _definition_15_10_5_3(),
            created_by=self.admin(),
        )


class RosterFinalityFactTests(_DeferredRosterBase):
    """``entry_roster_final`` is what tells "unknown" apart from "zero"."""

    def test_roster_is_not_final_while_registration_is_open(self):
        ruleset = self.bound_ruleset(phase=OPEN)
        ctx = self.context_for(self.version(ruleset))
        self.assertFalse(ctx["entry_roster_final"])
        self.assertIsNone(ctx["entry_size"], "an unopened roster must be unknown, not 0")
        self.assertIsNone(ctx["entry_candidates"])

    def test_roster_is_not_final_while_under_review(self):
        ruleset = self.bound_ruleset(phase=REVIEWING)
        self.approved(ruleset.activity, 3)
        ctx = self.context_for(self.version(ruleset))
        self.assertFalse(ctx["entry_roster_final"])
        self.assertIsNone(ctx["entry_size"])

    def test_roster_is_final_once_rehearsal_begins(self):
        ruleset = self.bound_ruleset(phase=SETTLED)
        self.approved(ruleset.activity, 3)
        ctx = self.context_for(self.version(ruleset))
        self.assertTrue(ctx["entry_roster_final"])
        self.assertEqual(ctx["entry_size"], 3)
        self.assertEqual(len(ctx["entry_candidates"]), 3)

    def test_zero_registrations_with_a_settled_roster_is_a_real_zero(self):
        """The distinction only holds if a genuinely empty settled roster still reads 0."""
        ruleset = self.bound_ruleset(phase=SETTLED)
        ctx = self.context_for(self.version(ruleset))
        self.assertTrue(ctx["entry_roster_final"])
        self.assertEqual(ctx["entry_size"], 0)


class PreRegistrationFreezeTests(_DeferredRosterBase):
    """The headline gate: a ruleset freezes before anyone has registered."""

    def test_freeze_passes_with_zero_registrations(self):
        ruleset = self.bound_ruleset(phase=OPEN)
        version = self.version(ruleset)
        frozen = freeze_ruleset_version(version, self.admin())
        self.assertEqual(frozen.status, RulesetVersion.Status.FROZEN)

    def test_deferred_quota_is_recorded_rather_than_silently_passed(self):
        """Not a false ERROR — and not a pretend PASS either: the obligation is visible."""
        ruleset = self.bound_ruleset(phase=OPEN)
        ctx = self.context_for(self.version(ruleset))
        report, _plan = compile_definition(_definition_15_10_5_3(), context=ctx, bound=True)
        self.assertNotIn("QUOTA_EXCEEDED", report.codes())
        self.assertTrue(report.passes(), [i.to_dict() for i in report.issues])
        deferred = [i for i in report.issues if i.severity is Severity.DEFERRED]
        self.assertTrue(deferred, "a deferred roster check must stay visible in the report")
        self.assertIn("QUOTA_UNVERIFIABLE", {i.code for i in deferred})

    def test_definition_errors_still_fail_the_freeze_before_registration(self):
        """Only roster facts are deferred — a broken definition must still abort.

        Parse-valid but compile-invalid: stage1's weights sum to 0.9, not 1.0.
        """
        ruleset = self.bound_ruleset(phase=OPEN)
        broken = json.loads(_definition_15_10_5_3())
        broken["nodes"][2]["aggregate"]["components"][1]["weight"] = 0.5
        version = self.version(ruleset, definition=json.dumps(broken, ensure_ascii=False))
        self.assertRaises(RulesetInvalidError, freeze_ruleset_version, version, self.admin())


class RuntimeReadinessTests(_DeferredRosterBase):
    """Fail closed once the roster exists; refuse to pretend before it does."""

    def _frozen_before_registration(self, title="deferred-runtime"):
        """Confirm the ruleset while the roster is still empty — the product flow."""
        ruleset = self.bound_ruleset(phase=OPEN, title=title)
        version = self.version(ruleset)
        freeze_ruleset_version(version, self.admin())
        version.refresh_from_db()
        return ruleset, version

    def _settle(self, ruleset, *, singers):
        """Registration closes: the roster becomes real and the phase moves on."""
        self.approved(ruleset.activity, singers)
        with authority_write(ACTIVITY_STATE):
            ruleset.activity.phase = SETTLED
            ruleset.activity.save(update_fields=["phase"])

    def test_readiness_refuses_before_the_roster_is_settled(self):
        _ruleset, version = self._frozen_before_registration()
        self.assertRaises(ValidationError, validate_ruleset_runtime_readiness, version)

    def test_readiness_fails_closed_when_the_roster_cannot_support_the_quota(self):
        """Frozen at 0, then only 7 singers ever register — top10 is impossible."""
        ruleset, version = self._frozen_before_registration()
        self._settle(ruleset, singers=7)
        with self.assertRaises(RulesetInvalidError) as caught:
            validate_ruleset_runtime_readiness(version)
        self.assertIn("QUOTA_EXCEEDED", caught.exception.report.codes())

    def test_readiness_passes_on_a_sufficient_roster(self):
        ruleset, version = self._frozen_before_registration()
        self._settle(ruleset, singers=15)
        report = validate_ruleset_runtime_readiness(version)
        self.assertTrue(report.passes(), [i.to_dict() for i in report.issues])


class VoteRosterDeferralTests(_DeferredRosterBase):
    """A score-component session's candidate list is a roster fact too."""

    def _definition_with_vote(self):
        """15→10→5→3 with a score-component vote folded into stage1 (weights still sum to 1)."""
        definition = json.loads(_definition_15_10_5_3())
        definition["nodes"].insert(
            2,
            {
                "key": "assess_a1",
                "type": "ASSESS",
                "source": ENTRY_KEY,
                "vote_source": "audience1",
                "vote_purpose": "SCORE_COMPONENT",
            },
        )
        components = definition["nodes"][3]["aggregate"]["components"]
        components[0]["weight"] = 0.3  # assess_r1
        components[1]["weight"] = 0.6  # assess_r2
        components.append({"source": "assess_a1", "weight": 0.1})
        return json.dumps(definition, ensure_ascii=False)

    def _ruleset_with_vote(self, *, phase=OPEN, title="deferred-vote"):
        ruleset = self.bound_ruleset(phase=phase, title=title)
        activity = ruleset.activity
        session = VoteSession.objects.create(
            activity=activity,
            name="成绩投票",
            passcode="0000",
            start_time=timezone.now() - timedelta(minutes=1),
            end_time=timezone.now() + timedelta(hours=1),
            purpose=VoteSession.Purpose.SCORE_COMPONENT,
            requires_ticket=True,
            is_test_data=True,
        )
        rule = configure_vote_scoring_rule(session, self.admin(), mode=VOTE_CONVERSION["mode"])
        ruleset.vote_keys = {"audience1": session.pk}
        ruleset.vote_scoring_rule_keys = {"audience1": rule.pk}
        ruleset.save(update_fields=["vote_keys", "vote_scoring_rule_keys"])
        return ruleset

    def test_candidate_roster_mismatch_is_deferred_not_an_error(self):
        ruleset = self._ruleset_with_vote()
        ctx = self.context_for(self.version(ruleset))
        report, _plan = compile_definition(self._definition_with_vote(), context=ctx, bound=True)
        self.assertNotIn("VOTE_ROSTER_MISMATCH", report.codes())
        self.assertTrue(report.passes(), [i.to_dict() for i in report.issues])
        self.assertIn(
            "VOTE_ROSTER_DEFERRED",
            {i.code for i in report.issues if i.severity is Severity.DEFERRED},
        )

    def test_candidate_roster_mismatch_fails_readiness(self):
        """Frozen with an empty session, then 15 singers register with no VoteOptions."""
        ruleset = self._ruleset_with_vote()
        version = self.version(ruleset, definition=self._definition_with_vote())
        freeze_ruleset_version(version, self.admin())
        version.refresh_from_db()
        self.approved(ruleset.activity, 15)
        with authority_write(ACTIVITY_STATE):
            ruleset.activity.phase = SETTLED
            ruleset.activity.save(update_fields=["phase"])
        with self.assertRaises(RulesetInvalidError) as caught:
            validate_ruleset_runtime_readiness(version)
        self.assertIn("VOTE_ROSTER_MISMATCH", caught.exception.report.codes())
