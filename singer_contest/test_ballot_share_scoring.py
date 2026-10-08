"""§5.4 / §5.5 / §7 — the ballot-share conversion truth.

The support rate of a candidate is ``candidate_valid_votes / valid_ballot_count * 100``.
The denominator is the number of *ballots*, never the number of vote records, never the sum
of all candidates' votes, and never the number of allowed selections — so a multi-select
session legitimately yields shares summing above 100%. A session with no valid ballot is not
a zero score: the source stays unbound so the resolver holds instead of inventing 0.
"""

import shutil
import tempfile
from datetime import timedelta
from decimal import Decimal

from accounts.models import User
from common.authority import (
    ACCOUNT_AUTHORITY,
    ACTIVITY_STATE,
    VOTE_BALLOT_WRITE,
    authority_write,
)
from core.models import Activity
from django.test import TestCase, override_settings
from django.utils import timezone
from ruleset.models import ContestRuleset, RulesetVersion
from ruleset.resolver import inputs_fingerprint
from ruleset.services import vote_scoring_binding_snapshot
from voting.models import VoteBallot, VoteOption, VoteRecord, VoteSession
from voting.services import configure_vote_scoring_rule

from .models import SingerRegistration
from .services import _combined_vote_scores, _source_vote_scores, bind_resolve_input

DEFINITION = (
    '{"schema_version": 1, "nodes": ['
    '{"key": "a1", "type": "ASSESS", "source": "entry", "vote_source": "audience1",'
    ' "vote_purpose": "SCORE_COMPONENT"},'
    '{"key": "rank1", "type": "RANK", "source": "a1", "descending": true}]}'
)


class BallotShareConversionTests(TestCase):
    def setUp(self):
        self.media_root = tempfile.mkdtemp()
        self.override = override_settings(MEDIA_ROOT=self.media_root)
        self.override.enable()
        self.addCleanup(self.override.disable)
        self.addCleanup(shutil.rmtree, self.media_root, True)
        with authority_write(ACCOUNT_AUTHORITY):
            self.staff = User.objects.create_user(
                username="ballot-staff", password="pass", role=User.Role.STAFF
            )
        with authority_write(ACTIVITY_STATE):
            self.activity = Activity.objects.create(
                title="院十佳",
                activity_type=Activity.Type.SINGER_CONTEST,
                is_test_mode=True,
            )
        self.singers = [
            SingerRegistration.objects.create(
                activity=self.activity,
                user=User.objects.create_user(username=f"voter-{index}", password="pass"),
                name=letter,
                student_id=f"70000{index}",
                college="College",
                class_name="Class",
                phone="13800000000",
                song_name="Song",
                pre_status=SingerRegistration.PreStatus.APPROVED,
                is_test_data=True,
            )
            for index, letter in enumerate("ABC")
        ]
        self.session = VoteSession.objects.create(
            activity=self.activity,
            name="成绩投票",
            passcode="0000",
            start_time=timezone.now() - timedelta(minutes=1),
            end_time=timezone.now() + timedelta(hours=1),
            selection_type=VoteSession.SelectionType.MULTI,
            max_selections=3,
            purpose=VoteSession.Purpose.SCORE_COMPONENT,
            requires_ticket=True,
            is_test_data=True,
        )
        self.options = [
            VoteOption.objects.create(
                vote_session=self.session, singer=singer, sort_order=i, is_test_data=True
            )
            for i, singer in enumerate(self.singers)
        ]
        self.rule = configure_vote_scoring_rule(self.session, self.staff)

    # --- fixtures ---------------------------------------------------------

    def _cast(self, index, *, ballot_selections, ballot_count=1):
        """Cast ``ballot_count`` ballots, each selecting ``ballot_selections`` singers."""
        for offset in range(ballot_count):
            key = f"browser-{index}-{offset}"
            with authority_write(VOTE_BALLOT_WRITE):
                ballot = VoteBallot.objects.create(
                    vote_session=self.session,
                    browser_session_key=key,
                    ip_address="127.0.0.1",
                    is_test_data=True,
                )
                for option in ballot_selections:
                    VoteRecord.objects.create(
                        ballot=ballot,
                        vote_session=self.session,
                        vote_option=self.options[option],
                        browser_session_key=key,
                        ip_address="127.0.0.1",
                        is_test_data=True,
                    )

    def _binding(self, *, source="audience1", with_rule=True):
        binding = {"vote_keys": {source: self.session.pk}}
        if with_rule:
            binding["vote_scoring_rule_keys"] = vote_scoring_binding_snapshot(
                {source: self.rule.pk}
            )
        return binding

    def _scores(self, *, with_rule=True):
        return _source_vote_scores(self.activity, self._binding(with_rule=with_rule))

    # --- denominator truth ------------------------------------------------

    def test_single_select_ballot_share(self):
        # 200 valid ballots, one choice each: A=136, B=41, C=23 -> 68.00 / 20.50 / 11.50.
        self._cast(0, ballot_selections=[0], ballot_count=136)
        self._cast(1, ballot_selections=[1], ballot_count=41)
        self._cast(2, ballot_selections=[2], ballot_count=23)

        scores = self._scores()["audience1"]

        self.assertEqual(self._valid_ballots(), 200)
        self.assertEqual(scores[str(self.singers[0].pk)], Decimal("68.00"))
        self.assertEqual(scores[str(self.singers[1].pk)], Decimal("20.50"))
        self.assertEqual(scores[str(self.singers[2].pk)], Decimal("11.50"))

    def test_multi_select_shares_may_sum_above_one_hundred(self):
        # The §2.5 example, rebuilt as real ballots: 200 valid ballots over three
        # candidates where some ballots select more than one singer, giving
        # A=136, B=101, C=76 -> 68.00 / 50.50 / 38.00 (sum 156.50, legitimately > 100).
        self._cast(0, ballot_selections=[0, 1, 2], ballot_count=40)
        self._cast(1, ballot_selections=[0, 1], ballot_count=30)
        self._cast(2, ballot_selections=[0], ballot_count=66)
        self._cast(3, ballot_selections=[1, 2], ballot_count=3)
        self._cast(4, ballot_selections=[2], ballot_count=33)
        self._cast(5, ballot_selections=[1], ballot_count=28)

        scores = self._scores()["audience1"]

        self.assertEqual(self._valid_ballots(), 200)
        self.assertEqual(scores[str(self.singers[0].pk)], Decimal("68.00"))
        self.assertEqual(scores[str(self.singers[1].pk)], Decimal("50.50"))
        self.assertEqual(scores[str(self.singers[2].pk)], Decimal("38.00"))
        self.assertEqual(sum(scores.values()), Decimal("156.50"))

    def test_denominator_is_ballots_not_vote_records(self):
        # 10 ballots, 3 of which select A while every ballot selects two singers:
        # 20 vote records exist, but A's share is 3/10 = 30.00, not 3/20 = 15.00.
        self._cast(0, ballot_selections=[0, 1], ballot_count=3)
        self._cast(1, ballot_selections=[1, 2], ballot_count=7)

        scores = self._scores()["audience1"]

        self.assertEqual(VoteRecord.objects.filter(vote_session=self.session).count(), 20)
        self.assertEqual(self._valid_ballots(), 10)
        self.assertEqual(scores[str(self.singers[0].pk)], Decimal("30.00"))
        self.assertEqual(scores[str(self.singers[1].pk)], Decimal("100.00"))

    def test_rounding_is_explicit_and_stable(self):
        # 3 ballots: 1/3 -> 33.3333 and 2/3 -> 66.6667 (4dp, ROUND_HALF_UP).
        self._cast(0, ballot_selections=[0], ballot_count=1)
        self._cast(1, ballot_selections=[1], ballot_count=2)

        scores = self._scores()["audience1"]

        self.assertEqual(scores[str(self.singers[0].pk)], Decimal("33.3333"))
        self.assertEqual(scores[str(self.singers[1].pk)], Decimal("66.6667"))

    # --- empty and unbound states ----------------------------------------

    def test_zero_ballots_do_not_become_a_zero_score(self):
        self.assertEqual(self._valid_ballots(), 0)
        self.assertEqual(self._scores(), {})

    def test_unbound_source_keeps_raw_counts(self):
        # Without an explicitly bound conversion rule the loader yields the raw vote
        # counts (unit ``votes``), which the compiler then refuses as a score component.
        self._cast(0, ballot_selections=[0], ballot_count=5)

        scores = self._scores(with_rule=False)["audience1"]

        self.assertEqual(scores[str(self.singers[0].pk)], Decimal("5"))
        self.assertEqual(scores[str(self.singers[2].pk)], Decimal("0"))

    def test_zero_vote_candidate_is_a_legal_zero(self):
        self._cast(0, ballot_selections=[0], ballot_count=4)
        scores = self._scores()["audience1"]
        self.assertEqual(scores[str(self.singers[2].pk)], Decimal("0.0000"))

    # --- replay ----------------------------------------------------------

    def test_locked_vote_replays_identically(self):
        self._cast(0, ballot_selections=[0, 1], ballot_count=4)
        ruleset = ContestRuleset.objects.create(
            activity=self.activity, name="RS", is_test_data=True
        )
        version = RulesetVersion.objects.create(ruleset=ruleset, version=1, definition=DEFINITION)

        first = self._combined_scores()
        second = self._combined_scores()

        self.assertEqual(first, second)
        self.assertEqual(
            inputs_fingerprint(
                bind_resolve_input(version, self.activity, round_keys={}, vote_scores=first)
            ),
            inputs_fingerprint(
                bind_resolve_input(version, self.activity, round_keys={}, vote_scores=second)
            ),
        )

    def _combined_scores(self):
        return _combined_vote_scores(self.activity, self._binding())

    def _valid_ballots(self):
        return VoteBallot.objects.filter(vote_session=self.session, is_test_data=True).count()
