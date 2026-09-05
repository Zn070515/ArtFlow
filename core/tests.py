from common.authority import ACCOUNT_AUTHORITY, ACTIVITY_STATE, authority_write
from common.models import AuditLog
from django.contrib import admin
from django.contrib.auth import get_user_model
from django.core.exceptions import PermissionDenied, ValidationError
from django.test import RequestFactory, TestCase
from django.utils import timezone

from .models import Activity, ActivityPhase, QRCodeLink
from .policies import ActivityAction, allowed_actions, ensure_activity_action_allowed
from .services import (
    _enter_archived_phase_locked,
    transition_activity_phase,
    unarchive_activity,
)

User = get_user_model()


def create_provisioned_user(*args, **kwargs):
    with authority_write(ACCOUNT_AUTHORITY):
        return User.objects.create_user(*args, **kwargs)


class CoreModelTests(TestCase):
    def test_activity_phase_and_qr_link_models_exist(self):
        activity = Activity.objects.create(
            title="Singer Contest",
            activity_type=Activity.Type.SINGER_CONTEST,
        )
        phase = ActivityPhase.objects.create(
            activity=activity,
            phase=Activity.Phase.REGISTRATION_OPEN,
            name="Registration",
        )
        qr_link = QRCodeLink.objects.create(
            activity=activity,
            kind=QRCodeLink.Kind.REGISTRATION,
            title="Apply",
            target_url="/contest/apply/",
        )
        self.assertEqual(str(phase), "Singer Contest - Registration")
        self.assertEqual(str(qr_link), "Singer Contest - Apply")

    def test_activity_requires_lifecycle_service_to_promote_to_formal(self):
        activity = Activity.objects.create(
            title="Test Contest",
            activity_type=Activity.Type.SINGER_CONTEST,
            is_test_mode=True,
        )
        activity.is_test_mode = False
        with self.assertRaises(ValidationError):
            activity.save()

    def test_activity_forbids_formal_activity_reentering_test_mode(self):
        activity = Activity.objects.create(
            title="Formal Contest",
            activity_type=Activity.Type.SINGER_CONTEST,
            is_test_mode=False,
        )
        activity.is_test_mode = True
        with self.assertRaises(ValidationError):
            activity.save()

    def test_activity_allows_transition_when_lifecycle_flag_set(self):
        activity = Activity.objects.create(
            title="Test Contest",
            activity_type=Activity.Type.SINGER_CONTEST,
            is_test_mode=True,
        )
        activity.is_test_mode = False
        activity.save(_allow_lifecycle_transition=True)
        activity.refresh_from_db()
        self.assertFalse(activity.is_test_mode)
        self.assertEqual(activity.data_lifecycle, Activity.DataLifecycle.FORMAL)


class ActivityCreationAuthorityTests(TestCase):
    def test_activity_instance_creation_rejects_lock_provenance(self):
        user = User.objects.create_user(username="activity-instance-lock-provenance")
        activity = Activity(
            title="Instance lock provenance",
            activity_type=Activity.Type.SINGER_CONTEST,
            locked_at=timezone.now(),
            locked_by=user,
        )

        with self.assertRaises(ValidationError):
            activity.save()

        self.assertFalse(Activity.objects.filter(title=activity.title).exists())

    def test_activity_creation_rejects_non_initial_state_through_both_managers(self):
        for manager, title in (
            (Activity.objects, "Default manager live"),
            (Activity._base_manager, "Base manager live"),
        ):
            with self.subTest(manager=manager.name):
                with self.assertRaises(ValidationError):
                    manager.create(
                        title=title,
                        activity_type=Activity.Type.SINGER_CONTEST,
                        phase=Activity.Phase.LIVE,
                    )
                self.assertFalse(Activity.objects.filter(title=title).exists())

    def test_activity_bulk_create_rejects_archived_initial_state_through_both_managers(self):
        for manager, title in (
            (Activity.objects, "Default bulk archived"),
            (Activity._base_manager, "Base bulk archived"),
        ):
            with self.subTest(manager=manager.name):
                with self.assertRaises(ValidationError):
                    manager.bulk_create(
                        [
                            Activity(
                                title=title,
                                activity_type=Activity.Type.SINGER_CONTEST,
                                phase=Activity.Phase.ARCHIVED,
                            )
                        ]
                    )
                self.assertFalse(Activity.objects.filter(title=title).exists())

    def test_activity_bulk_create_update_conflicts_rejects_state_change(self):
        activity = Activity.objects.create(
            title="Conflict target", activity_type=Activity.Type.SINGER_CONTEST
        )

        with self.assertRaises(ValidationError):
            Activity.objects.bulk_create(
                [
                    Activity(
                        pk=activity.pk,
                        title=activity.title,
                        activity_type=activity.activity_type,
                        phase=Activity.Phase.LIVE,
                    )
                ],
                update_conflicts=True,
                update_fields=["phase"],
                unique_fields=["pk"],
            )

        activity.refresh_from_db()
        self.assertEqual(activity.phase, Activity.Phase.DRAFT)

    def test_activity_creation_rejects_lock_provenance_through_both_managers(self):
        user = User.objects.create_user(username="activity-lock-provenance")
        for manager, title, provenance in (
            (Activity.objects, "Default locked at", {"locked_at": timezone.now()}),
            (Activity._base_manager, "Base locked by", {"locked_by": user}),
        ):
            with self.subTest(manager=manager.name, title=title):
                with self.assertRaises(ValidationError):
                    manager.create(
                        title=title,
                        activity_type=Activity.Type.SINGER_CONTEST,
                        **provenance,
                    )
                self.assertFalse(Activity.objects.filter(title=title).exists())

    def test_activity_bulk_create_rejects_lock_provenance_through_both_managers(self):
        user = User.objects.create_user(username="activity-bulk-lock-provenance")
        for manager, title, provenance in (
            (Activity.objects, "Default bulk locked at", {"locked_at": timezone.now()}),
            (Activity._base_manager, "Base bulk locked by", {"locked_by": user}),
        ):
            with self.subTest(manager=manager.name, title=title):
                with self.assertRaises(ValidationError):
                    manager.bulk_create(
                        [
                            Activity(
                                title=title,
                                activity_type=Activity.Type.SINGER_CONTEST,
                                **provenance,
                            )
                        ]
                    )
                self.assertFalse(Activity.objects.filter(title=title).exists())

    def test_activity_bulk_create_update_conflicts_rejects_lock_provenance_through_both_managers(
        self,
    ):
        user = User.objects.create_user(username="activity-conflict-lock-provenance")
        for manager, title, provenance in (
            (Activity.objects, "Default provenance conflict target", {"locked_at": timezone.now()}),
            (Activity._base_manager, "Base provenance conflict target", {"locked_by": user}),
        ):
            with self.subTest(manager=manager.name, title=title):
                activity = Activity.objects.create(
                    title=title, activity_type=Activity.Type.SINGER_CONTEST
                )

                with self.assertRaises(ValidationError):
                    manager.bulk_create(
                        [
                            Activity(
                                pk=activity.pk,
                                title="Provenance conflict bypass",
                                activity_type=activity.activity_type,
                                **provenance,
                            )
                        ],
                        update_conflicts=True,
                        update_fields=["title"],
                        unique_fields=["pk"],
                    )

                activity.refresh_from_db()
                self.assertEqual(activity.title, title)
                self.assertIsNone(activity.locked_at)
                self.assertIsNone(activity.locked_by_id)


class ActivityDeletionAuthorityTests(TestCase):
    def _activity(self, title, **kwargs):
        return Activity.objects.create(
            title=title,
            activity_type=Activity.Type.SINGER_CONTEST,
            **kwargs,
        )

    def test_activity_delete_rejects_formal_locked_and_non_draft_parents(self):
        formal = self._activity("Formal", is_test_mode=False)
        locked = self._activity("Locked")
        non_draft = self._activity("Live")
        with authority_write(ACTIVITY_STATE):
            Activity.objects.filter(pk=locked.pk).update(is_locked=True)
            Activity.objects.filter(pk=non_draft.pk).update(phase=Activity.Phase.LIVE)

        with self.assertRaises(ValidationError):
            non_draft.delete()
        with self.assertRaises(ValidationError):
            Activity.objects.filter(pk=formal.pk).delete()
        with self.assertRaises(ValidationError):
            Activity._base_manager.filter(pk=locked.pk).delete()

        self.assertEqual(Activity.objects.filter(pk__in=[formal.pk, locked.pk, non_draft.pk]).count(), 3)

    def test_activity_delete_allows_only_explicit_test_draft_cleanup_scope(self):
        activity = self._activity("Cleanup")

        with self.assertRaises(ValidationError):
            activity.delete()
        with authority_write("test_data.cleanup"):
            activity.delete()

        self.assertFalse(Activity.objects.filter(pk=activity.pk).exists())

    def test_activity_delete_rejects_formal_singer_registration_and_preserves_it(self):
        from singer_contest.models import SingerRegistration

        activity = self._activity("Formal registration")
        singer = SingerRegistration.objects.create(
            activity=activity,
            user=User.objects.create_user(username="formal-registration-owner"),
            name="Formal singer",
            student_id="formal-registration-1",
            college="College",
            class_name="Class",
            phone="13800000000",
            song_name="Song",
            pre_status=SingerRegistration.PreStatus.APPROVED,
            is_test_data=False,
        )

        with authority_write("test_data.cleanup"):
            with self.assertRaises(ValidationError):
                activity.delete()

        self.assertTrue(Activity.objects.filter(pk=activity.pk).exists())
        self.assertTrue(SingerRegistration.objects.filter(pk=singer.pk, is_test_data=False).exists())

    def test_activity_delete_rejects_formal_award_and_preserves_it(self):
        from singer_contest.models import Award, SingerRegistration

        activity = self._activity("Formal award")
        singer = SingerRegistration.objects.create(
            activity=activity,
            user=User.objects.create_user(username="formal-award-owner"),
            name="Award singer",
            student_id="formal-award-1",
            college="College",
            class_name="Class",
            phone="13800000001",
            song_name="Song",
            pre_status=SingerRegistration.PreStatus.APPROVED,
            is_test_data=False,
        )
        award = Award.objects.create(
            activity=activity,
            singer=singer,
            name="Formal award",
            is_test_data=False,
        )

        with authority_write("test_data.cleanup"):
            with self.assertRaises(ValidationError):
                Activity._base_manager.filter(pk=activity.pk).delete()

        self.assertTrue(Activity.objects.filter(pk=activity.pk).exists())
        self.assertTrue(Award.objects.filter(pk=award.pk, is_test_data=False).exists())

    def test_activity_delete_rejects_formal_archive_package_and_preserves_it(self):
        from archive.models import ArchivePackage

        activity = self._activity("Formal archive")
        archive_package = ArchivePackage.objects.create(activity=activity, note="Formal archive")

        with authority_write("test_data.cleanup"):
            with self.assertRaises(ValidationError):
                activity.delete()

        self.assertTrue(Activity.objects.filter(pk=activity.pk).exists())
        self.assertTrue(ArchivePackage.objects.filter(pk=archive_package.pk).exists())

    def test_activity_delete_rejects_formal_descendant_of_test_runtime_data(self):
        from singer_contest.models import SingerRegistration
        from voting.models import VoteOption, VoteSession

        activity = self._activity("Formal nested vote option")
        singer = SingerRegistration.objects.create(
            activity=activity,
            user=User.objects.create_user(username="nested-formal-option-owner"),
            name="Test singer",
            student_id="nested-formal-option-1",
            college="College",
            class_name="Class",
            phone="13800000002",
            song_name="Song",
            pre_status=SingerRegistration.PreStatus.APPROVED,
            is_test_data=True,
        )
        session = VoteSession.objects.create(
            activity=activity,
            name="Test vote",
            passcode="test-passcode",
            start_time=timezone.now(),
            end_time=timezone.now() + timezone.timedelta(hours=1),
            is_test_data=True,
        )
        option = VoteOption.objects.create(
            vote_session=session,
            singer=singer,
            is_test_data=False,
        )

        with authority_write("test_data.cleanup"):
            with self.assertRaises(ValidationError):
                activity.delete()

        self.assertTrue(Activity.objects.filter(pk=activity.pk).exists())
        self.assertTrue(VoteOption.objects.filter(pk=option.pk, is_test_data=False).exists())

    def test_activity_delete_requires_explicit_removal_of_test_runtime_children(self):
        from voting.models import VoteSession

        activity = self._activity("Test runtime cleanup")
        vote_session = VoteSession.objects.create(
            activity=activity,
            name="Test vote",
            passcode="test-passcode",
            start_time=timezone.now(),
            end_time=timezone.now() + timezone.timedelta(hours=1),
            is_test_data=True,
        )

        with authority_write("test_data.cleanup"):
            with self.assertRaises(ValidationError):
                activity.delete()
            vote_session.delete()
            activity.delete()

        self.assertFalse(Activity.objects.filter(pk=activity.pk).exists())

    def test_formal_activity_admin_disables_delete(self):
        from .admin import ActivityAdmin

        activity = self._activity("Formal admin", is_test_mode=False)
        request = RequestFactory().get("/admin/core/activity/")
        request.user = User.objects.create_superuser("activity-delete-admin", "admin@example.com", "pass")

        self.assertFalse(ActivityAdmin(Activity, admin.site).has_delete_permission(request, activity))


class ActivityPhasePolicyTests(TestCase):
    def _activity(self, phase=None):
        activity = Activity(
            title="Contest",
            activity_type=Activity.Type.SINGER_CONTEST,
            **({"phase": phase} if phase is not None else {}),
        )
        if activity.phase != Activity.Phase.DRAFT:
            with authority_write(ACTIVITY_STATE):
                activity.save()
        else:
            activity.save()
        return activity

    def test_draft_does_not_allow_scoring(self):
        activity = self._activity()
        self.assertEqual(activity.phase, Activity.Phase.DRAFT)
        self.assertNotIn(ActivityAction.SCORE, allowed_actions(activity))

    def test_registration_open_allows_submission(self):
        activity = self._activity(Activity.Phase.REGISTRATION_OPEN)
        self.assertIn(ActivityAction.SUBMIT_REGISTRATION, allowed_actions(activity))

    def test_results_published_cannot_change_registration_state(self):
        activity = self._activity(Activity.Phase.RESULTS_PUBLISHED)
        for action in (
            ActivityAction.SUBMIT_REGISTRATION,
            ActivityAction.REVIEW_REGISTRATION,
            ActivityAction.UPLOAD_MATERIAL,
            ActivityAction.SCORE,
        ):
            self.assertNotIn(action, allowed_actions(activity))

    def test_archived_is_read_only(self):
        activity = self._activity(Activity.Phase.ARCHIVED)
        self.assertEqual(allowed_actions(activity), frozenset())
        for action in (
            ActivityAction.SUBMIT_REGISTRATION,
            ActivityAction.REVIEW_REGISTRATION,
            ActivityAction.UPLOAD_MATERIAL,
            ActivityAction.SCORE,
            ActivityAction.MANAGE_VOTE,
            ActivityAction.ARCHIVE,
        ):
            self.assertNotIn(action, allowed_actions(activity))

    def test_ensure_activity_action_allowed_raises_when_disallowed(self):
        activity = self._activity(Activity.Phase.ARCHIVED)
        with self.assertRaises(PermissionDenied):
            ensure_activity_action_allowed(activity, ActivityAction.UPLOAD_MATERIAL)

    def test_ensure_activity_action_allowed_passes_when_allowed(self):
        activity = self._activity(Activity.Phase.LIVE)
        ensure_activity_action_allowed(activity, ActivityAction.SCORE)

    def test_publish_result_criven_in_live_and_results_pending(self):
        """§36-37: 核定并锁定 stage result is authorized during the show and after compute."""
        self.assertIn(
            ActivityAction.PUBLISH_RESULT, allowed_actions(self._activity(Activity.Phase.LIVE))
        )
        self.assertIn(
            ActivityAction.PUBLISH_RESULT,
            allowed_actions(self._activity(Activity.Phase.RESULTS_PENDING)),
        )
        # Not allowed before scoring or once archived.
        self.assertNotIn(
            ActivityAction.PUBLISH_RESULT, allowed_actions(self._activity(Activity.Phase.DRAFT))
        )
        self.assertNotIn(
            ActivityAction.PUBLISH_RESULT, allowed_actions(self._activity(Activity.Phase.ARCHIVED))
        )


class ActivityPhaseTransitionTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="phase-admin", password="pass")
        self.activity = Activity.objects.create(
            title="Contest",
            activity_type=Activity.Type.SINGER_CONTEST,
            phase=Activity.Phase.DRAFT,
        )

    def test_forward_transition_succeeds_and_audits(self):
        result = transition_activity_phase(
            self.activity, Activity.Phase.REGISTRATION_OPEN, actor=self.user
        )
        self.assertEqual(result.phase, Activity.Phase.REGISTRATION_OPEN)
        self.assertTrue(
            AuditLog.objects.filter(
                action_type=AuditLog.ActionType.PHASE_TRANSITION,
                operator=self.user,
                old_value=Activity.Phase.DRAFT,
                new_value=Activity.Phase.REGISTRATION_OPEN,
            ).exists()
        )

    def test_backward_transition_is_rejected(self):
        live = Activity(
            title="Live",
            activity_type=Activity.Type.SINGER_CONTEST,
            phase=Activity.Phase.LIVE,
        )
        with authority_write(ACTIVITY_STATE):
            live.save()
        with self.assertRaises(PermissionDenied):
            transition_activity_phase(live, Activity.Phase.DRAFT, actor=self.user)
        live.refresh_from_db()
        self.assertEqual(live.phase, Activity.Phase.LIVE)

    def test_draft_cannot_skip_to_results_pending(self):
        with self.assertRaises(PermissionDenied):
            transition_activity_phase(
                self.activity, Activity.Phase.RESULTS_PENDING, actor=self.user
            )
        self.activity.refresh_from_db()
        self.assertEqual(self.activity.phase, Activity.Phase.DRAFT)

    def test_draft_cannot_skip_to_results_published(self):
        with self.assertRaises(PermissionDenied):
            transition_activity_phase(
                self.activity, Activity.Phase.RESULTS_PUBLISHED, actor=self.user
            )
        self.activity.refresh_from_db()
        self.assertEqual(self.activity.phase, Activity.Phase.DRAFT)

    def test_archived_cannot_return_to_live(self):
        archived = Activity(
            title="Archived",
            activity_type=Activity.Type.SINGER_CONTEST,
            phase=Activity.Phase.ARCHIVED,
        )
        with authority_write(ACTIVITY_STATE):
            archived.save()
        with self.assertRaises(PermissionDenied):
            transition_activity_phase(archived, Activity.Phase.LIVE, actor=self.user)

    def test_same_phase_is_noop_and_does_not_audit(self):
        transition_activity_phase(self.activity, Activity.Phase.DRAFT, actor=self.user)
        self.assertFalse(
            AuditLog.objects.filter(action_type=AuditLog.ActionType.PHASE_TRANSITION).exists()
        )

    def test_locked_activity_cannot_transition(self):
        with authority_write(ACTIVITY_STATE):
            Activity.objects.filter(pk=self.activity.pk).update(is_locked=True)
        with self.assertRaises(PermissionDenied):
            transition_activity_phase(
                self.activity, Activity.Phase.REGISTRATION_OPEN, actor=self.user
            )
        self.activity.refresh_from_db()
        self.assertEqual(self.activity.phase, Activity.Phase.DRAFT)
        self.assertFalse(
            AuditLog.objects.filter(action_type=AuditLog.ActionType.PHASE_TRANSITION).exists()
        )

    def test_unknown_phase_is_rejected(self):
        with self.assertRaises(ValidationError):
            transition_activity_phase(self.activity, "not_a_phase", actor=self.user)

    def test_generic_transition_rejects_archived(self):
        with self.assertRaises(PermissionDenied):
            transition_activity_phase(self.activity, Activity.Phase.ARCHIVED, actor=self.user)
        self.activity.refresh_from_db()
        self.assertEqual(self.activity.phase, Activity.Phase.DRAFT)
        self.assertFalse(
            AuditLog.objects.filter(action_type=AuditLog.ActionType.PHASE_TRANSITION).exists()
        )

    def test_archived_phase_only_entered_via_archive_authority(self):
        result = _enter_archived_phase_locked(self.activity, actor=self.user)
        self.assertEqual(result.phase, Activity.Phase.ARCHIVED)
        self.assertTrue(
            AuditLog.objects.filter(
                action_type=AuditLog.ActionType.PHASE_TRANSITION,
                operator=self.user,
                old_value=Activity.Phase.DRAFT,
                new_value=Activity.Phase.ARCHIVED,
            ).exists()
        )
        # No generic successor set may reach ARCHIVED; only the archive service does.
        expecting_archived = Activity(
            title="Second",
            activity_type=Activity.Type.SINGER_CONTEST,
            phase=Activity.Phase.RESULTS_PUBLISHED,
        )
        with authority_write(ACTIVITY_STATE):
            expecting_archived.save()
        with self.assertRaises(PermissionDenied):
            transition_activity_phase(expecting_archived, Activity.Phase.ARCHIVED, actor=self.user)


class ActivityUnarchiveTests(TestCase):
    def setUp(self):
        self.admin = create_provisioned_user(
            username="unarchive-admin", password="pass", role=User.Role.ADMIN
        )
        self.staff = create_provisioned_user(
            username="unarchive-staff", password="pass", role=User.Role.STAFF
        )
        with authority_write(ACTIVITY_STATE):
            self.activity = Activity.objects.create(
                title="Contest",
                activity_type=Activity.Type.SINGER_CONTEST,
                phase=Activity.Phase.ARCHIVED,
                is_test_mode=False,
                is_locked=True,
            )

    def test_unarchive_rejects_non_admin(self):
        with self.assertRaises(PermissionDenied):
            unarchive_activity(self.activity, actor=self.staff)
        self.activity.refresh_from_db()
        self.assertEqual(self.activity.phase, Activity.Phase.ARCHIVED)

    def test_unarchive_rejects_non_archived_activity(self):
        self.activity.phase = Activity.Phase.RESULTS_PUBLISHED
        with authority_write(ACTIVITY_STATE):
            self.activity.save(update_fields=["phase"])
        with self.assertRaises(PermissionDenied):
            unarchive_activity(self.activity, actor=self.admin)

    def test_unarchive_restores_results_published_unlocks_and_audits(self):
        result = unarchive_activity(self.activity, actor=self.admin, note="moved back")
        self.assertEqual(result.phase, Activity.Phase.RESULTS_PUBLISHED)
        self.assertFalse(result.is_locked)
        self.assertIsNone(result.locked_at)
        self.assertTrue(
            AuditLog.objects.filter(
                action_type=AuditLog.ActionType.UNARCHIVE_ACTIVITY,
                operator=self.admin,
                target=f"Activity:{self.activity.pk}",
                old_value=Activity.Phase.ARCHIVED,
                new_value=Activity.Phase.RESULTS_PUBLISHED,
            ).exists()
        )
