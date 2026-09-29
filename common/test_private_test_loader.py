import os
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest import skipUnless

from accounts.models import User
from core.models import Activity
from core.services import transition_activity_phase
from django.core.exceptions import PermissionDenied, ValidationError
from django.test import TestCase, override_settings
from ruleset.compiler import Severity, compile_definition
from ruleset.models import ContestRuleset, RulesetVersion
from ruleset.services import build_bound_context
from ruleset.templates import GOLDEN_SCHIDUI
from singer_contest.models import ContestRound, RubricCriterion, ScoringRubric

from common.authority import ACCOUNT_AUTHORITY, ACTIVITY_STATE, authority_write
from common.private_test_fixture import PrivateTestFixture
from common.private_test_loader import (
    FIXTURE_LIFECYCLE,
    PrivateTestLoadError,
    _activity_for_fixture,
    _advance_to,
    apply_private_fixture,
)


def _operator(username="private-loader-operator"):
    with authority_write(ACCOUNT_AUTHORITY):
        return User.objects.create_user(
            username=username,
            password="test-password-123!",
            role=User.Role.ADMIN,
        )


class PrivateTestLoaderBoundaryTests(TestCase):
    def setUp(self):
        self.operator = _operator()
        with authority_write(ACTIVITY_STATE):
            self.formal = Activity.objects.create(
                title="ArtFlow 私测｜Synthetic rehearsal",
                subtitle="formal-unrelated-activity",
                activity_type=Activity.Type.SINGER_CONTEST,
                is_test_mode=False,
            )
        self.fixture = SimpleNamespace(
            reference={
                "fixture_id": "synthetic-fixture",
                "event": {"title": "Synthetic rehearsal"},
            }
        )

    def test_formal_activity_with_fixture_title_is_rejected(self):
        with self.assertRaises(PrivateTestLoadError):
            _activity_for_fixture(self.fixture, "synthetic-fixture", self.operator)

    def test_the_fixture_activity_opens_registration_rather_than_settling_the_roster(self):
        """The fixture freezes its ruleset before anyone has submitted, so its activity
        must not claim the roster is settled. TESTING would: it is roster-final, an empty
        roster there is a real zero, and the golden ruleset's top10 would then fail the
        freeze with QUOTA_EXCEEDED."""
        fixture = SimpleNamespace(
            reference={
                "fixture_id": "phase-choice-fixture",
                "event": {"title": "Phase choice rehearsal"},
            }
        )
        activity = _activity_for_fixture(fixture, "phase-choice-fixture", self.operator)
        self.assertEqual(activity.phase, Activity.Phase.REGISTRATION_OPEN)


@skipUnless(
    os.environ.get("ARTFLOW_PRIVATE_FIXTURE_ROOT"),
    "set ARTFLOW_PRIVATE_FIXTURE_ROOT to run the package-level private rehearsal",
)
class PrivateFixturePackageIntegrationTests(TestCase):
    """Run the real sanitized v3 package without putting it in the repository."""

    def setUp(self):
        self.operator = _operator("private-package-integration")
        self.media = TemporaryDirectory()
        self.media_override = override_settings(MEDIA_ROOT=self.media.name)
        self.media_override.enable()
        self.addCleanup(self.media_override.disable)
        self.addCleanup(self.media.cleanup)

    def test_v3_package_reaches_a_complete_idempotent_rehearsal(self):
        from files.models import MaterialCheck, SubmissionFile
        from questionnaire.models import QuestionnaireResponse
        from singer_contest.models import CriterionScore, StageResult
        from tickets.models import Ticket
        from voting.models import VoteBallot

        fixture = PrivateTestFixture.from_root(Path(os.environ["ARTFLOW_PRIVATE_FIXTURE_ROOT"]))
        loaded = apply_private_fixture(
            fixture,
            activity_key=fixture.reference["fixture_id"],
            operator_username=self.operator.username,
        )
        activity = loaded.activity
        self.assertEqual(activity.singer_registrations.filter(is_test_data=True).count(), 15)
        self.assertEqual(
            QuestionnaireResponse.objects.filter(
                singer_registration__activity=activity, is_test_data=True
            ).count(),
            15,
        )
        self.assertEqual(
            SubmissionFile.objects.filter(
                singer_registration__activity=activity,
                is_test_data=True,
                is_current=True,
            )
            .exclude(question_key="")
            .count(),
            60,
        )
        self.assertEqual(
            MaterialCheck.objects.filter(singer_registration__activity=activity)
            .exclude(question_key="")
            .filter(
                file_purpose__in=(
                    "accompaniment",
                    "performance_video",
                    "background_video",
                    "program_image",
                    "lyrics_script",
                ),
                status=MaterialCheck.Status.UPLOADED,
            )
            .count(),
            60,
        )
        self.assertEqual(
            CriterionScore.objects.filter(
                score_record__round__activity=activity, is_test_data=True
            ).count(),
            555,
        )
        self.assertEqual(Ticket.objects.filter(activity=activity, is_test_data=True).count(), 280)
        self.assertEqual(
            VoteBallot.objects.filter(
                vote_session__activity=activity, is_test_data=True
            ).count(),
            310,
        )
        self.assertEqual(
            set(
                StageResult.objects.filter(activity=activity, is_test_data=True)
                .filter(status=StageResult.Status.CONFIRMED)
                .values_list("stage_key", flat=True)
            ),
            {"stage1", "stage2", "stage3"},
        )

        repeated = apply_private_fixture(
            fixture,
            activity_key=fixture.reference["fixture_id"],
            operator_username=self.operator.username,
        )
        self.assertEqual(repeated.report["status"], "already_loaded_noop")


class FixtureFreezeOrderTests(TestCase):
    """The property the loader's phase choice exists to protect, proved directly."""

    def setUp(self):
        self.operator = _operator("fixture-order-operator")

    def _bound_ruleset(self, *, phase):
        with authority_write(ACTIVITY_STATE):
            activity = Activity.objects.create(
                title=f"fixture-order-{phase}",
                activity_type=Activity.Type.SINGER_CONTEST,
                phase=phase,
                is_test_mode=True,
            )
        ruleset = ContestRuleset.objects.create(activity=activity, name="RS", is_test_data=True)
        binding = {}
        for key in ("r1", "r2", "r3", "r4"):
            rubric = ScoringRubric.objects.create(
                activity=activity, name=f"{key}评分", is_test_data=True
            )
            RubricCriterion.objects.create(
                rubric=rubric, name="总分", max_score=100, is_test_data=True
            )
            contest_round = ContestRound.objects.create(
                activity=activity, round_type=ContestRound.RoundType.PRELIMINARY, name=key
            )
            contest_round.rubric = rubric
            contest_round.save(update_fields=["rubric"])
            binding[key] = contest_round.pk
        ruleset.round_keys = binding
        ruleset.save(update_fields=["round_keys"])
        return ContestRuleset.objects.get(pk=ruleset.pk)

    def _report(self, *, phase):
        """The golden ruleset compiled against a bound context with nobody approved.

        It is compared at the compiler rather than through ``freeze_ruleset_version``
        because the golden definition also binds two vote sessions that this fixture does
        not stand up; the quota question does not need them, and the report is exactly what
        the freeze reads.
        """
        ruleset = self._bound_ruleset(phase=phase)
        version = RulesetVersion.objects.create(ruleset=ruleset, definition=GOLDEN_SCHIDUI)
        context = build_bound_context(version, {"round_keys": ruleset.round_keys})
        report, _plan = compile_definition(GOLDEN_SCHIDUI, context=context, bound=True)
        return report, context

    def test_a_registration_phase_activity_treats_the_empty_roster_as_unknown(self):
        """The golden ruleset selects a top10 from a roster nobody has joined yet -- which
        is legal, because during registration the roster is unknown rather than zero."""
        report, context = self._report(phase=Activity.Phase.REGISTRATION_OPEN)
        self.assertFalse(context["entry_roster_final"])
        self.assertNotIn("QUOTA_EXCEEDED", report.codes())
        deferred = {issue.code for issue in report.issues if issue.severity is Severity.DEFERRED}
        self.assertIn("QUOTA_UNVERIFIABLE", deferred)

    def test_a_settled_roster_with_nobody_approved_is_a_real_zero(self):
        """The characterisation behind the fixture's phase: TESTING counts as settled, so
        the same top10 is then a real QUOTA_EXCEEDED and the freeze would abort."""
        report, context = self._report(phase=Activity.Phase.TESTING)
        self.assertTrue(context["entry_roster_final"])
        self.assertIn("QUOTA_EXCEEDED", report.codes())


class AdvanceLadderTests(TestCase):
    def setUp(self):
        self.operator = _operator("fixture-ladder-operator")

    def _activity(self, phase):
        with authority_write(ACTIVITY_STATE):
            return Activity.objects.create(
                title=f"ladder-{phase}",
                activity_type=Activity.Type.SINGER_CONTEST,
                phase=phase,
                is_test_mode=True,
            )

    def test_it_walks_forward_to_the_target(self):
        activity = self._activity(Activity.Phase.REGISTRATION_OPEN)
        moved = _advance_to(activity, Activity.Phase.REHEARSAL, self.operator)
        self.assertEqual(moved.phase, Activity.Phase.REHEARSAL)

    def test_it_leaves_an_activity_already_at_the_target_alone(self):
        activity = self._activity(Activity.Phase.REHEARSAL)
        self.assertEqual(
            _advance_to(activity, Activity.Phase.REHEARSAL, self.operator).phase,
            Activity.Phase.REHEARSAL,
        )

    def test_it_does_not_walk_backwards(self):
        """Re-requesting a phase already passed would be a backwards move, which the
        lifecycle forbids -- so the ladder starts from where the activity is."""
        activity = self._activity(Activity.Phase.REHEARSAL)
        moved = _advance_to(activity, Activity.Phase.RESULTS_PENDING, self.operator)
        self.assertEqual(moved.phase, Activity.Phase.RESULTS_PENDING)

    def test_an_activity_before_the_ladder_starts_at_its_first_entry(self):
        activity = self._activity(Activity.Phase.TESTING)
        self.assertEqual(
            _advance_to(activity, Activity.Phase.REGISTRATION_OPEN, self.operator).phase,
            Activity.Phase.REGISTRATION_OPEN,
        )

    def test_an_unknown_target_is_refused(self):
        activity = self._activity(Activity.Phase.REGISTRATION_OPEN)
        with self.assertRaises(PrivateTestLoadError):
            _advance_to(activity, "archived", self.operator)

    def test_the_ladder_starts_at_registration_open(self):
        self.assertEqual(FIXTURE_LIFECYCLE[0], Activity.Phase.REGISTRATION_OPEN)


class PhaseTransitionGuardTests(TestCase):
    """Guard against the ladder accidentally being asked to move backwards."""

    def test_moving_backwards_is_refused_by_the_lifecycle(self):
        with authority_write(ACCOUNT_AUTHORITY):
            operator = User.objects.create_user(
                username="fixture-backwards", password="pass", role=User.Role.ADMIN
            )
        with authority_write(ACTIVITY_STATE):
            activity = Activity.objects.create(
                title="backwards",
                activity_type=Activity.Type.SINGER_CONTEST,
                phase=Activity.Phase.REHEARSAL,
                is_test_mode=True,
            )
        with self.assertRaises((PermissionDenied, ValidationError)):
            transition_activity_phase(
                activity, Activity.Phase.REGISTRATION_OPEN, actor=operator, note="test"
            )
