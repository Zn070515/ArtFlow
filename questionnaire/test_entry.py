"""The one registration entry every link lands on.

Before this the product entries all pointed at the legacy fixed form, so a participant
following the home page, their profile, the "my registrations" empty state or a QR code
never reached the questionnaire at all — it was reachable only by someone who knew its URL.
The path resolver is what makes the Switch step real: an activity with a frozen
questionnaire resolves to it, an activity without one keeps the legacy form, and no
participant has to know which is which.
"""

import json
from uuid import uuid4

from common.authority import ACCOUNT_AUTHORITY, authority_write
from common.test_characterization import _CharacterizationBase
from core.models import Activity
from django.urls import reverse
from ruleset.models import ContestRuleset, RulesetVersion
from ruleset.services import freeze_ruleset_version
from singer_contest.models import ContestRound, RubricCriterion, ScoringRubric, SingerRegistration

from .test_form import QUESTIONNAIRE, _definition


class _EntryBase(_CharacterizationBase):
    def operator(self):
        from accounts.models import User

        cached = getattr(self, "_operator_user", None)
        if cached is not None:
            return cached
        user = self.make_user(f"entry-admin-{uuid4().hex[:8]}")
        user.role = User.Role.ADMIN
        with authority_write(ACCOUNT_AUTHORITY):
            user.save()
        self._operator_user = user
        return user

    def activity(self, *, with_questionnaire=True, lifecycle=Activity.DataLifecycle.FORMAL):
        from common.authority import ACTIVITY_STATE

        with authority_write(ACTIVITY_STATE):
            activity = Activity.objects.create(
                title=f"入口-{uuid4().hex[:6]}",
                activity_type=Activity.Type.SINGER_CONTEST,
                phase=Activity.Phase.REGISTRATION_OPEN,
                data_lifecycle=lifecycle,
                is_test_mode=lifecycle == Activity.DataLifecycle.TEST,
            )
        ruleset = ContestRuleset.objects.create(
            activity=activity,
            name="RS",
            is_test_data=activity.is_test_mode,
        )
        rubric = ScoringRubric.objects.create(
            activity=activity, name="r3评分", is_test_data=activity.is_test_mode
        )
        RubricCriterion.objects.create(
            rubric=rubric, name="总分", max_score=100, is_test_data=activity.is_test_mode
        )
        contest_round = ContestRound.objects.create(
            activity=activity, round_type=ContestRound.RoundType.PRELIMINARY, name="r3"
        )
        contest_round.rubric = rubric
        contest_round.save(update_fields=["rubric"])
        ruleset.round_keys = {"r3": contest_round.pk}
        ruleset.save(update_fields=["round_keys"])
        for i in range(3):
            SingerRegistration.objects.create(
                activity=activity,
                user=self.make_user(f"entry-field-{activity.pk}-{i}"),
                name=f"选手{i}",
                student_id=f"10{i:04d}",
                college="学院",
                class_name="班级",
                phone="13800000000",
                pre_status=SingerRegistration.PreStatus.APPROVED,
                is_test_data=activity.is_test_mode,
            )
        root = json.loads(_definition())
        if with_questionnaire:
            root["questionnaire"] = QUESTIONNAIRE
        version = RulesetVersion.objects.create(
            ruleset=ruleset, definition=json.dumps(root, ensure_ascii=False)
        )
        freeze_ruleset_version(version, self.operator())
        return activity


class RegisterEntryTests(_EntryBase):
    def setUp(self):
        super().setUp()
        self.participant = self.make_user(f"entry-singer-{uuid4().hex[:8]}")
        self.client.force_login(self.participant)

    def test_an_activity_with_a_questionnaire_resolves_to_the_questionnaire(self):
        activity = self.activity(with_questionnaire=True)
        response = self.client.get(reverse("register:activity", args=[activity.pk]))
        self.assertRedirects(response, reverse("questionnaire:form", args=[activity.pk]))

    def test_an_activity_without_a_questionnaire_resolves_to_the_legacy_form(self):
        activity = self.activity(with_questionnaire=False)
        response = self.client.get(reverse("register:activity", args=[activity.pk]))
        self.assertEqual(response.status_code, 302)
        self.assertTrue(response.url.startswith(reverse("singer_contest:apply")))

    def test_a_deep_link_into_the_legacy_form_is_resolved_too(self):
        """A QR code or a bookmark that still names the old form must land on the real one."""
        activity = self.activity(with_questionnaire=True)
        response = self.client.get(reverse("singer_contest:apply"), {"activity": activity.pk})
        self.assertRedirects(response, reverse("questionnaire:form", args=[activity.pk]))

    def test_the_chooser_lists_open_activities(self):
        activity = self.activity(with_questionnaire=True)
        response = self.client.get(reverse("register:choose"))
        self.assertContains(response, activity.title)
        self.assertContains(response, reverse("register:activity", args=[activity.pk]))

    def test_the_chooser_hides_test_activities_from_participants(self):
        hidden = self.activity(with_questionnaire=True, lifecycle=Activity.DataLifecycle.TEST)
        response = self.client.get(reverse("register:choose"))
        self.assertNotContains(response, hidden.title)

    def test_staff_see_test_activities_in_the_chooser(self):
        hidden = self.activity(with_questionnaire=True, lifecycle=Activity.DataLifecycle.TEST)
        self.client.force_login(self.operator())
        self.assertContains(self.client.get(reverse("register:choose")), hidden.title)

    def test_the_registration_qr_points_at_the_resolver(self):
        activity = self.activity(with_questionnaire=True)
        self.client.force_login(self.operator())
        response = self.client.get(reverse("staff:qr_image", args=[activity.pk, "registration"]))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response["Content-Type"], "image/png")


class ProductEntryTests(_EntryBase):
    def setUp(self):
        super().setUp()
        self.participant = self.make_user(f"entry-home-{uuid4().hex[:8]}")
        self.client.force_login(self.participant)

    def test_the_home_page_sends_a_participant_to_the_chooser(self):
        self.assertContains(
            self.client.get(reverse("public_portal:home")), reverse("register:choose")
        )

    def test_the_profile_page_sends_a_participant_to_the_chooser(self):
        self.assertContains(
            self.client.get(reverse("accounts:profile")), reverse("register:choose")
        )

    def test_my_registrations_empty_state_sends_a_participant_to_the_chooser(self):
        self.assertContains(
            self.client.get(reverse("singer_contest:my_registrations")),
            reverse("register:choose"),
        )
