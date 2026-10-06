"""§5.7 / §6 / §7.3 — a SCORE_COMPONENT vote source must bind a real conversion.

Two layers are covered:

- the compiler's bound gates (synthetic context, fast): a raw vote session can never feed
  a weighted composite, a score-component source must require an entry ticket, a node's
  declared purpose must match the session's, and the session's candidate roster must equal
  the ASSESS source pool it scores;
- a real bound freeze: the conversion authority (session id, rule id, mode, output scale)
  ends up in the frozen ``RulesetVersion.binding`` snapshot, so a later replay reads the
  frozen identity instead of "whatever rule the session has now".
"""

import json
from datetime import timedelta

from common.authority import ACCOUNT_AUTHORITY, RULESET_FREEZE, authority_write
from django.test import SimpleTestCase
from django.utils import timezone
from singer_contest.models import (
    ContestRound,
    RubricCriterion,
    ScoringRubric,
    SingerRegistration,
)
from voting.models import VoteOption, VoteSession
from voting.services import configure_vote_scoring_rule

from ruleset.compiler import compile_definition
from ruleset.schema import ENTRY_KEY

from .models import ContestRuleset, RulesetVersion
from .services import RulesetInvalidError, freeze_ruleset_version
from .test_schema import _RulesetModelBase

VOTE_CONVERSION = {
    "mode": "ballot_share_percent",
    "scale": "hundred",
}


def _definition(*, purpose="SCORE_COMPONENT"):
    return json.dumps(
        {
            "schema_version": 1,
            "nodes": [
                {"key": "assess_r1", "type": "ASSESS", "source": ENTRY_KEY, "round": "r1"},
                {
                    "key": "assess_a1",
                    "type": "ASSESS",
                    "source": ENTRY_KEY,
                    "vote_source": "audience1",
                    "vote_purpose": purpose,
                },
                {
                    "key": "stage1",
                    "type": "AGGREGATE",
                    "within": ENTRY_KEY,
                    "aggregate": {
                        "type": "weighted_sum",
                        "components": [
                            {"source": "assess_r1", "weight": 0.9},
                            {"source": "assess_a1", "weight": 0.1},
                        ],
                    },
                },
                {"key": "rank1", "type": "RANK", "source": "stage1", "descending": True},
                {"key": "top1", "type": "SELECT", "source": "rank1", "count": 1},
            ],
        },
        ensure_ascii=False,
    )


def _select_sourced_definition():
    """A score-component vote that scores a SELECT roster rather than the entry pool."""
    return json.dumps(
        {
            "schema_version": 1,
            "nodes": [
                {"key": "assess_r1", "type": "ASSESS", "source": ENTRY_KEY, "round": "r1"},
                {"key": "rank1", "type": "RANK", "source": "assess_r1", "descending": True},
                {"key": "top1", "type": "SELECT", "source": "rank1", "count": 1},
                {
                    "key": "assess_a1",
                    "type": "ASSESS",
                    "source": "top1",
                    "vote_source": "audience1",
                    "vote_purpose": "SCORE_COMPONENT",
                },
                {
                    "key": "stage1",
                    "type": "AGGREGATE",
                    "within": "top1",
                    "aggregate": {
                        "type": "weighted_sum",
                        "components": [
                            {"source": "assess_r1", "weight": 0.9},
                            {"source": "assess_a1", "weight": 0.1},
                        ],
                    },
                },
            ],
        },
        ensure_ascii=False,
    )


def _context(*, vote, candidates=("1", "2"), entry_size=2):
    return {
        "entry_size": entry_size,
        "entry_candidates": list(candidates),
        "rounds": {"r1": {"judge_count": 5, "scope": "full", "scale": "100"}},
        "votes": {"audience1": vote},
        "groups": {},
    }


def _converted_vote(**overrides):
    vote = {
        "scale": "hundred",
        "purpose": "score_component",
        "requires_ticket": True,
        "candidates": ["1", "2"],
        "scoring_rule": 11,
        "conversion": VOTE_CONVERSION["mode"],
    }
    vote.update(overrides)
    return vote


class VoteScoringBindingCompilerGateTests(SimpleTestCase):
    """The compiler refuses a score-component vote without a conversion authority."""

    def _codes(self, *, vote, purpose="SCORE_COMPONENT", candidates=("1", "2"), entry_size=2):
        report, _plan = compile_definition(
            _definition(purpose=purpose),
            context=_context(vote=vote, candidates=candidates, entry_size=entry_size),
            bound=True,
        )
        return report.codes(), report

    def test_converted_ballot_share_is_freeze_legal(self):
        codes, report = self._codes(vote=_converted_vote())
        self.assertNotIn("VOTE_SCORE_COMPONENT_RAW", codes)
        self.assertNotIn("VOTE_SCORE_COMPONENT_REQUIRES_TICKET", codes)
        self.assertTrue(report.passes(), [i.to_dict() for i in report.issues])

    def test_raw_vote_session_cannot_feed_the_composite(self):
        codes, _ = self._codes(
            vote={"scale": "votes", "purpose": "score_component", "requires_ticket": True}
        )
        self.assertIn("VOTE_SCORE_COMPONENT_RAW", codes)

    def test_score_component_source_must_require_a_ticket(self):
        codes, _ = self._codes(vote=_converted_vote(requires_ticket=False))
        self.assertIn("VOTE_SCORE_COMPONENT_REQUIRES_TICKET", codes)

    def test_node_purpose_must_match_the_session_purpose(self):
        codes, _ = self._codes(vote=_converted_vote(purpose="selection"))
        self.assertIn("VOTE_PURPOSE_MISMATCH", codes)

    def test_candidate_roster_must_equal_the_source_pool_size(self):
        # A non-entry source has a known size (the SELECT count) but no bound identity, so
        # the check falls back to counting: 2 candidates cannot score a 1-person roster.
        report, _plan = compile_definition(
            _select_sourced_definition(),
            context=_context(vote=_converted_vote(candidates=["1", "2"]), candidates=("1",)),
            bound=True,
        )
        self.assertIn("VOTE_ROSTER_MISMATCH", report.codes())

    def test_candidate_roster_must_equal_the_source_pool_identity(self):
        # Same size, different people: identity is what makes a roster drift real.
        codes, _ = self._codes(
            vote=_converted_vote(candidates=["1", "9"]),
            candidates=("1", "2"),
            entry_size=2,
        )
        self.assertIn("VOTE_ROSTER_MISMATCH", codes)

    def test_audience_score_source_needs_no_conversion(self):
        # The staff-entered AudienceScore channel is a hundred-scale score by definition;
        # it carries no candidate roster and must not trip the vote gates.
        codes, report = self._codes(vote={"scale": "hundred"})
        self.assertNotIn("VOTE_ROSTER_MISMATCH", codes)
        self.assertNotIn("VOTE_SCORE_COMPONENT_RAW", codes)
        self.assertTrue(report.passes(), [i.to_dict() for i in report.issues])


class FrozenVoteScoringBindingTests(_RulesetModelBase):
    """A bound freeze snapshots the conversion authority it consumed."""

    def _admin(self):
        from accounts.models import User

        user = self.make_user("vote-scoring-admin")
        user.role = User.Role.ADMIN
        with authority_write(ACCOUNT_AUTHORITY):
            user.save()
        return user

    def _fixture(
        self,
        *,
        purpose=VoteSession.Purpose.SCORE_COMPONENT,
        requires_ticket=True,
        with_rule=True,
        with_options=True,
        weaken_ticket_after_rule=False,
    ):
        admin = self._admin()
        activity = self.make_activity(is_test_mode=True)
        ruleset = ContestRuleset.objects.create(activity=activity, name="RS", is_test_data=True)
        singer = self.make_singer(
            activity,
            username="binding-singer",
            student_id="880001",
            pre_status=SingerRegistration.PreStatus.APPROVED,
            is_test_data=True,
        )
        rubric = ScoringRubric.objects.create(activity=activity, name="r1", is_test_data=True)
        RubricCriterion.objects.create(rubric=rubric, name="标准", max_score=100, is_test_data=True)
        contest_round = ContestRound.objects.create(
            activity=activity,
            round_type=ContestRound.RoundType.PRELIMINARY,
            name="r1",
        )
        contest_round.rubric = rubric
        contest_round.save(update_fields=["rubric"])
        session = VoteSession.objects.create(
            activity=activity,
            name="成绩投票",
            passcode="0000",
            start_time=timezone.now() - timedelta(minutes=1),
            end_time=timezone.now() + timedelta(hours=1),
            purpose=purpose,
            requires_ticket=requires_ticket,
            is_test_data=True,
        )
        if with_options:
            VoteOption.objects.create(vote_session=session, singer=singer, is_test_data=True)
        rule = configure_vote_scoring_rule(session, admin) if with_rule else None
        if weaken_ticket_after_rule:
            # The rule service refuses to configure a session without ticket checking, so a
            # weakened session is only reachable by editing the (still closed, still
            # unbound) configuration afterwards. The freeze must catch that state.
            VoteSession.objects.filter(pk=session.pk).update(requires_ticket=False)
        ruleset.round_keys = {"r1": contest_round.pk}
        ruleset.vote_keys = {"audience1": session.pk}
        ruleset.vote_scoring_rule_keys = {"audience1": rule.pk} if rule else {}
        ruleset.save(
            update_fields=["round_keys", "vote_keys", "vote_scoring_rule_keys"],
        )
        with authority_write(RULESET_FREEZE):
            version = RulesetVersion.objects.create(
                ruleset=ruleset,
                version=1,
                definition=_definition(),
                is_current=False,
            )
        return admin, ruleset, session, rule, version

    def test_freeze_snapshots_session_rule_mode_and_scale(self):
        admin, _ruleset, session, rule, version = self._fixture()
        frozen = freeze_ruleset_version(version, admin)
        frozen.refresh_from_db()
        binding = frozen.binding
        self.assertEqual(binding["vote_keys"], {"audience1": session.pk})
        snapshot = binding["vote_scoring_rule_keys"]["audience1"]
        self.assertEqual(snapshot["rule"], rule.pk)
        self.assertEqual(snapshot["mode"], "ballot_share_percent")
        self.assertEqual(snapshot["scale"], "hundred")

    def test_a_present_snapshot_is_the_authority_even_without_round_keys(self):
        """A stored snapshot is self-authoritative; only a missing one may read the ruleset.

        The fallback used to fire whenever the snapshot had no stage key, round keys and
        group-stage keys — which is exactly the shape of a vote-only snapshot, because
        _snapshot_binding always writes all nine keys and leaves the irrelevant ones empty.
        A frozen vote-only version therefore resolved against the still-editable
        ContestRuleset, so binding the ruleset after the freeze silently changed the frozen
        version's meaning, and the fallback dropped vote_scoring_rule_keys entirely.
        """
        from singer_contest.services import _version_binding

        admin, ruleset, session, rule, version = self._fixture()
        frozen = freeze_ruleset_version(version, admin)
        snapshot = {
            "stage_key": "",
            "round_keys": {},
            "vote_keys": {"audience1": session.pk},
            "vote_scoring_rule_keys": {
                "audience1": {
                    "rule": rule.pk,
                    "mode": "ballot_share_percent",
                    "scale": "hundred",
                }
            },
            "group_keys": {},
            "group_stage_keys": {},
            "audience_keys": {},
            "announcement_blocks": [],
            "announcement_blocks_by_checkpoint": {},
        }
        with authority_write(RULESET_FREEZE):
            RulesetVersion.objects.filter(pk=frozen.pk).update(binding=snapshot)

        # Move the editable ruleset to a different vote source, as `ruleset_bind` may.
        ruleset.vote_keys = {"audience1": 424242}
        ruleset.save(update_fields=["vote_keys"])

        frozen.refresh_from_db()
        binding = _version_binding(frozen)

        self.assertEqual(binding["vote_keys"], {"audience1": session.pk})
        self.assertIn("vote_scoring_rule_keys", binding)

    def test_freeze_refuses_a_score_component_without_a_conversion_rule(self):
        admin, _ruleset, _session, _rule, version = self._fixture(with_rule=False)
        with self.assertRaises(RulesetInvalidError) as caught:
            freeze_ruleset_version(version, admin)
        self.assertIn("VOTE_SCORE_COMPONENT_RAW", caught.exception.report.codes())

    def test_freeze_refuses_a_score_component_without_ticket_checking(self):
        admin, _ruleset, _session, _rule, version = self._fixture(weaken_ticket_after_rule=True)
        with self.assertRaises(RulesetInvalidError) as caught:
            freeze_ruleset_version(version, admin)
        self.assertIn("VOTE_SCORE_COMPONENT_REQUIRES_TICKET", caught.exception.report.codes())

    def test_freeze_refuses_a_roster_that_does_not_match_the_entry_pool(self):
        admin, _ruleset, _session, _rule, version = self._fixture(with_options=False)
        with self.assertRaises(RulesetInvalidError) as caught:
            freeze_ruleset_version(version, admin)
        self.assertIn("VOTE_ROSTER_MISMATCH", caught.exception.report.codes())
