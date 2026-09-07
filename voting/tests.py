import threading
import time
from datetime import timedelta
from unittest import skipUnless

from accounts.models import User
from common.authority import (
    ACCOUNT_AUTHORITY,
    ACTIVITY_STATE,
    VOTE_SESSION_STATE,
    authority_write,
)
from common.models import AuditLog
from common.test_data import clear_activity_test_data
from core.models import Activity
from django.core.cache import cache
from django.core.exceptions import PermissionDenied, ValidationError
from django.db import OperationalError, connection, transaction
from django.test import TestCase, TransactionTestCase
from django.urls import reverse
from django.utils import timezone
from singer_contest.models import ContestRound, Judge, SingerRegistration
from singer_contest.services import apply_scores, prepare_round

from .models import VoteBallot, VoteOption, VoteRecord, VoteSession
from .services import (
    close_vote_session,
    lock_vote_session,
    open_vote_session,
    submit_ballot,
    unlock_vote_session,
)


def create_provisioned_user(*args, **kwargs):
    with authority_write(ACCOUNT_AUTHORITY):
        return User.objects.create_user(*args, **kwargs)


def create_vote_session(**kwargs):
    is_open = kwargs.pop("is_open", False)
    is_locked = kwargs.pop("is_locked", False)
    session = VoteSession.objects.create(**kwargs)
    if is_open or is_locked:
        session.is_open = is_open
        session.is_locked = is_locked
        with authority_write(VOTE_SESSION_STATE):
            session.save(update_fields=["is_open", "is_locked"])
    return session


def create_activity(**kwargs):
    activity = Activity(**kwargs)
    if activity.phase != Activity.Phase.DRAFT or activity.is_locked:
        with authority_write(ACTIVITY_STATE):
            activity.save()
    else:
        activity.save()
    return activity


class VotePublicStagingBoundaryTests(TestCase):
    """TEST activity vote sessions are invisible to anonymous/ordinary users.

    M0-U: a TEST VoteSession must 404 for anyone who is not authenticated
    staff/admin, across entry, cast (including a forged POST), and done.
    """

    def setUp(self):
        self.participant = User.objects.create_user(
            username="vote-participant", password="pass", role=User.Role.PARTICIPANT
        )
        self.staff = create_provisioned_user(
            username="vote-staff", password="pass", role=User.Role.STAFF
        )
        self.admin = create_provisioned_user(
            username="vote-admin", password="pass", role=User.Role.ADMIN
        )

    def _make_session(self, *, is_test_mode):
        activity = create_activity(
            title="Vote Activity",
            activity_type=Activity.Type.SINGER_CONTEST,
            is_test_mode=is_test_mode,
        )
        singer = SingerRegistration.objects.create(
            activity=activity,
            user=self.participant,
            name="Singer",
            student_id="20269999",
            college="College",
            class_name="Class",
            phone="13800000000",
            song_name="Song",
            pre_status=SingerRegistration.PreStatus.APPROVED,
            is_test_data=is_test_mode,
        )
        session = create_vote_session(
            activity=activity,
            name="Popularity",
            passcode="1234",
            start_time=timezone.now() - timedelta(minutes=1),
            end_time=timezone.now() + timedelta(minutes=10),
            is_open=True,
            is_test_data=is_test_mode,
        )
        option = VoteOption.objects.create(
            vote_session=session, singer=singer, is_test_data=is_test_mode
        )
        return session, option

    def test_test_session_anonymous_entry_404(self):
        session, _ = self._make_session(is_test_mode=True)
        response = self.client.get(reverse("voting:vote_entry", args=[session.pk]))
        self.assertEqual(response.status_code, 404)

    def test_test_session_participant_entry_404(self):
        session, _ = self._make_session(is_test_mode=True)
        self.client.force_login(self.participant)
        response = self.client.get(reverse("voting:vote_entry", args=[session.pk]))
        self.assertEqual(response.status_code, 404)

    def test_test_session_anonymous_direct_cast_404(self):
        session, _ = self._make_session(is_test_mode=True)
        response = self.client.get(reverse("voting:vote_cast", args=[session.pk]))
        self.assertEqual(response.status_code, 404)

    def test_test_session_forged_post_cast_404_no_ballot(self):
        session, option = self._make_session(is_test_mode=True)
        response = self.client.post(
            reverse("voting:vote_cast", args=[session.pk]),
            {"selected_option": [option.pk]},
        )
        self.assertEqual(response.status_code, 404)
        self.assertEqual(VoteBallot.objects.filter(vote_session=session).count(), 0)

    def test_test_session_staff_preview_and_cast_allowed(self):
        session, option = self._make_session(is_test_mode=True)
        self.client.force_login(self.staff)
        entry = self.client.get(reverse("voting:vote_entry", args=[session.pk]))
        self.assertEqual(entry.status_code, 200)
        self.client.post(reverse("voting:vote_entry", args=[session.pk]), {"passcode": "1234"})
        cast = self.client.post(
            reverse("voting:vote_cast", args=[session.pk]),
            {"selected_option": [option.pk]},
        )
        self.assertEqual(cast.status_code, 302)
        self.assertEqual(VoteBallot.objects.filter(vote_session=session).count(), 1)

    def test_test_session_verified_admin_allowed(self):
        session, _ = self._make_session(is_test_mode=True)
        self.client.force_login(self.admin)
        response = self.client.get(reverse("voting:vote_entry", args=[session.pk]))
        self.assertEqual(response.status_code, 200)

    def test_formal_session_anonymous_flow_unchanged(self):
        session, _ = self._make_session(is_test_mode=False)
        response = self.client.get(reverse("voting:vote_entry", args=[session.pk]))
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "Popularity")

    def test_formal_valid_passcode_cast_still_works(self):
        session, option = self._make_session(is_test_mode=False)
        self.client.post(reverse("voting:vote_entry", args=[session.pk]), {"passcode": "1234"})
        cast = self.client.post(
            reverse("voting:vote_cast", args=[session.pk]),
            {"selected_option": [option.pk]},
        )
        self.assertEqual(cast.status_code, 302)
        self.assertEqual(VoteBallot.objects.filter(vote_session=session).count(), 1)


class VoteBallotTests(TestCase):
    def setUp(self):
        user = User.objects.create_user(username="participant", password="pass")
        second_user = User.objects.create_user(username="participant-two", password="pass")
        activity = create_activity(
            title="Contest",
            activity_type=Activity.Type.SINGER_CONTEST,
        )
        singer = SingerRegistration.objects.create(
            activity=activity,
            user=user,
            name="Singer",
            student_id="20260001",
            college="College",
            class_name="Class",
            phone="13800000000",
            song_name="Song",
            pre_status=SingerRegistration.PreStatus.APPROVED,
        )
        second_singer = SingerRegistration.objects.create(
            activity=activity,
            user=second_user,
            name="Second Singer",
            student_id="20260002",
            college="College",
            class_name="Class",
            phone="13800000001",
            song_name="Song 2",
            pre_status=SingerRegistration.PreStatus.APPROVED,
        )
        self.session = create_vote_session(
            activity=activity,
            name="Popularity",
            passcode="1234",
            start_time=timezone.now() - timedelta(minutes=1),
            end_time=timezone.now() + timedelta(minutes=10),
            is_open=True,
        )
        self.option = VoteOption.objects.create(vote_session=self.session, singer=singer)
        self.second_option = VoteOption.objects.create(
            vote_session=self.session, singer=second_singer
        )

    def test_same_browser_can_submit_only_one_ballot(self):
        first = submit_ballot(
            self.session,
            browser_session_key="browser-1",
            option_ids=[self.option.pk],
            ip_address="10.0.0.1",
        )
        second = submit_ballot(
            self.session,
            browser_session_key="browser-1",
            option_ids=[self.second_option.pk],
            ip_address="10.0.0.1",
        )

        self.assertEqual(first.pk, second.pk)
        self.assertEqual(VoteBallot.objects.filter(vote_session=self.session).count(), 1)
        self.assertEqual(VoteRecord.objects.filter(vote_session=self.session).count(), 1)
        self.assertEqual(VoteRecord.objects.get().vote_option_id, self.option.pk)

    def test_different_browsers_sharing_ip_can_vote(self):
        submit_ballot(
            self.session,
            browser_session_key="browser-1",
            option_ids=[self.option.pk],
            ip_address="10.0.0.1",
        )
        submit_ballot(
            self.session,
            browser_session_key="browser-2",
            option_ids=[self.second_option.pk],
            ip_address="10.0.0.1",
        )

        self.assertEqual(VoteBallot.objects.filter(ip_address="10.0.0.1").count(), 2)

    def test_submit_ballot_rejects_option_from_another_session(self):
        other_session = create_vote_session(
            activity=self.session.activity,
            name="Other",
            passcode="5678",
            start_time=self.session.start_time,
            end_time=self.session.end_time,
            is_open=True,
        )
        foreign_option = VoteOption.objects.create(
            vote_session=other_session, singer=self.option.singer
        )

        with self.assertRaises(ValidationError):
            submit_ballot(
                self.session,
                browser_session_key="browser-3",
                option_ids=[foreign_option.pk],
                ip_address="10.0.0.2",
            )

        self.assertFalse(VoteBallot.objects.filter(browser_session_key="browser-3").exists())

    def test_submit_ballot_revalidates_state_after_lock(self):
        stale_session = self.session  # in-memory copy still reports open
        with authority_write(VOTE_SESSION_STATE):
            VoteSession.objects.filter(pk=self.session.pk).update(is_locked=True, is_open=False)

        with self.assertRaises(ValidationError):
            submit_ballot(
                stale_session,
                browser_session_key="browser-lock",
                option_ids=[self.option.pk],
                ip_address="10.0.0.5",
            )

        self.assertEqual(VoteBallot.objects.filter(vote_session=self.session).count(), 0)


class VoteActivityLockOverlayTests(TestCase):
    """The Activity global lock is an overlay that rejects public ballots."""

    def setUp(self):
        self.user = User.objects.create_user(username="overlay-voter", password="pass")
        self.activity = create_activity(
            title="Overlay Contest",
            activity_type=Activity.Type.SINGER_CONTEST,
            phase=Activity.Phase.REGISTRATION_OPEN,
            is_test_mode=False,
            is_locked=False,
        )
        singer = SingerRegistration.objects.create(
            activity=self.activity,
            user=self.user,
            name="Overlay Singer",
            student_id="20260001",
            college="College",
            class_name="Class",
            phone="13800000000",
            song_name="Song",
            pre_status=SingerRegistration.PreStatus.APPROVED,
        )
        self.session = create_vote_session(
            activity=self.activity,
            name="Popularity",
            passcode="1234",
            start_time=timezone.now() - timedelta(minutes=1),
            end_time=timezone.now() + timedelta(minutes=10),
            is_open=True,
        )
        self.option = VoteOption.objects.create(vote_session=self.session, singer=singer)

    def _cast_ballot(self):
        client = self.client_class()
        entry = client.post(
            reverse("voting:vote_entry", args=[self.session.pk]),
            {"passcode": self.session.passcode},
        )
        self.assertEqual(entry.status_code, 302)
        return client.post(
            reverse("voting:vote_cast", args=[self.session.pk]),
            {"selected_option": [str(self.option.pk)]},
        )

    def test_activity_locked_while_session_open_rejects_ballot(self):
        with authority_write(ACTIVITY_STATE):
            Activity.objects.filter(pk=self.activity.pk).update(is_locked=True)

        response = self._cast_ballot()

        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "尚未开放或已锁定")
        self.assertEqual(VoteBallot.objects.filter(vote_session=self.session).count(), 0)

    def test_activity_unlock_resumes_voting_on_open_session(self):
        with authority_write(ACTIVITY_STATE):
            Activity.objects.filter(pk=self.activity.pk).update(is_locked=True)
        self._cast_ballot()
        self.assertEqual(VoteBallot.objects.filter(vote_session=self.session).count(), 0)

        with authority_write(ACTIVITY_STATE):
            Activity.objects.filter(pk=self.activity.pk).update(is_locked=False)
        response = self._cast_ballot()

        self.assertEqual(response.status_code, 302)
        self.assertEqual(response["Location"], reverse("voting:vote_done", args=[self.session.pk]))
        self.assertEqual(VoteBallot.objects.filter(vote_session=self.session).count(), 1)


@skipUnless(connection.vendor == "postgresql", "requires PostgreSQL row locks")
class VoteActivityLockConcurrencyTests(TransactionTestCase):
    """Verify the Activity row lock is taken before the child rows."""

    def setUp(self):
        self.admin = User.objects.create_user(username="concurrent-staff", password="pass")
        user = User.objects.create_user(username="concurrent-overlay-voter", password="pass")
        self.activity = create_activity(
            title="Concurrent Overlay Contest",
            activity_type=Activity.Type.SINGER_CONTEST,
            phase=Activity.Phase.REGISTRATION_OPEN,
            is_test_mode=True,
            is_locked=False,
        )
        self.singer = SingerRegistration.objects.create(
            activity=self.activity,
            user=user,
            name="Singer",
            student_id="20260001",
            college="College",
            class_name="Class",
            phone="13800000000",
            song_name="Song",
            pre_status=SingerRegistration.PreStatus.APPROVED,
            is_test_data=True,
        )
        self.session = create_vote_session(
            activity=self.activity,
            name="Popularity",
            passcode="1234",
            start_time=timezone.now() - timedelta(minutes=1),
            end_time=timezone.now() + timedelta(minutes=10),
            is_open=True,
            is_test_data=True,
        )
        self.option = VoteOption.objects.create(
            vote_session=self.session, singer=self.singer, is_test_data=True
        )
        self.judge = Judge.objects.create(activity=self.activity, name="Concurrent Judge")
        self.round = ContestRound.objects.create(
            activity=self.activity,
            round_type=ContestRound.RoundType.PRELIMINARY,
            scoring_mode=ContestRound.ScoringMode.AVERAGE,
            advance_count=1,
        )
        prepare_round(self.round, self.admin)

    def test_concurrent_activity_lock_rejects_ballot_after_commit(self):
        lock_held = threading.Event()
        release_lock = threading.Event()
        holder_error = {}

        def hold_activity_lock():
            try:
                with transaction.atomic():
                    activity = Activity.objects.select_for_update().get(pk=self.activity.pk)
                    activity.is_locked = True
                    with authority_write(ACTIVITY_STATE):
                        activity.save(update_fields=["is_locked"])
                    lock_held.set()
                    release_lock.wait(timeout=10)
            except Exception as error:  # pragma: no cover - diagnostic only
                holder_error["error"] = error
            finally:
                connection.close()

        holder = threading.Thread(target=hold_activity_lock)
        holder.start()
        self.assertTrue(lock_held.wait(timeout=10))

        submit_result: dict[str, object] = {}

        def try_submit():
            try:
                submit_ballot(
                    self.session,
                    browser_session_key="browser-overlay",
                    option_ids=[self.option.pk],
                    ip_address="10.0.0.9",
                )
                submit_result["accepted"] = True
            except ValidationError:
                submit_result["rejected"] = True
            except Exception as error:  # pragma: no cover - diagnostic only
                submit_result["error"] = error
            finally:
                connection.close()

        submitter = threading.Thread(target=try_submit)
        submitter.start()
        time.sleep(1)  # let the submitter block on the Activity row lock
        release_lock.set()
        holder.join(timeout=10)
        submitter.join(timeout=10)

        self.assertFalse(holder_error, holder_error)
        self.assertTrue(submit_result.get("rejected"), f"expected rejection, got {submit_result}")
        self.assertEqual(VoteBallot.objects.filter(vote_session=self.session).count(), 0)

    def test_clear_and_score_concurrently_do_not_deadlock(self):
        results: dict[str, str] = {}

        def run_clear():
            try:
                clear_activity_test_data(self.activity, operator=self.admin)
                results["clear"] = "ok"
            except OperationalError as error:
                results["clear"] = "deadlock" if "deadlock" in str(error).lower() else "error"
            except Exception:
                results["clear"] = "error"
            finally:
                connection.close()

        def run_score():
            try:
                apply_scores(self.round, {(self.singer.pk, self.judge.pk): "90"}, self.admin)
                results["score"] = "ok"
            except OperationalError as error:
                results["score"] = "deadlock" if "deadlock" in str(error).lower() else "error"
            except Exception:
                results["score"] = "error"
            finally:
                connection.close()

        threads = [threading.Thread(target=run_clear), threading.Thread(target=run_score)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=20)

        self.assertEqual(results.get("clear"), "ok")
        self.assertNotEqual(results.get("score"), "deadlock")


@skipUnless(connection.vendor == "postgresql", "requires PostgreSQL row locks")
class VoteBallotConcurrencyTests(TransactionTestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="concurrent-participant", password="pass")
        activity = create_activity(
            title="Concurrent Contest",
            activity_type=Activity.Type.SINGER_CONTEST,
        )
        singer = SingerRegistration.objects.create(
            activity=activity,
            user=self.user,
            name="Singer",
            student_id="20260001",
            college="College",
            class_name="Class",
            phone="13800000000",
            song_name="Song",
            pre_status=SingerRegistration.PreStatus.APPROVED,
        )
        self.session = create_vote_session(
            activity=activity,
            name="Popularity",
            passcode="1234",
            start_time=timezone.now() - timedelta(minutes=1),
            end_time=timezone.now() + timedelta(minutes=10),
            is_open=True,
        )
        self.option = VoteOption.objects.create(vote_session=self.session, singer=singer)

    def test_concurrent_lock_prevents_ballot_after_commit(self):
        lock_held = threading.Event()
        release_lock = threading.Event()
        holder_error = {}

        def hold_lock():
            try:
                with transaction.atomic():
                    session = VoteSession.objects.select_for_update().get(pk=self.session.pk)
                    session.is_open = False
                    session.is_locked = True
                    with authority_write(VOTE_SESSION_STATE):
                        session.save(update_fields=["is_open", "is_locked"])
                    lock_held.set()
                    release_lock.wait(timeout=10)
            except Exception as error:  # pragma: no cover - diagnostic only
                holder_error["error"] = error
            finally:
                connection.close()

        holder = threading.Thread(target=hold_lock)
        holder.start()
        self.assertTrue(lock_held.wait(timeout=10))

        submit_result: dict[str, object] = {}

        def try_submit():
            try:
                submit_ballot(
                    self.session,
                    browser_session_key="browser-race",
                    option_ids=[self.option.pk],
                    ip_address="10.0.0.9",
                )
                submit_result["accepted"] = True
            except ValidationError:
                submit_result["rejected"] = True
            except Exception as error:  # pragma: no cover - diagnostic only
                submit_result["error"] = error
            finally:
                connection.close()

        submitter = threading.Thread(target=try_submit)
        submitter.start()
        time.sleep(1)  # let the submitter block on the row lock
        release_lock.set()
        holder.join(timeout=10)
        submitter.join(timeout=10)

        self.assertFalse(holder_error, holder_error)
        self.assertTrue(submit_result.get("rejected"), f"expected rejection, got {submit_result}")
        self.assertEqual(VoteBallot.objects.filter(vote_session=self.session).count(), 0)


class VoteStateServiceTests(TestCase):
    def setUp(self):
        self.operator = create_provisioned_user(
            username="vote-admin", password="pass", role=User.Role.ADMIN
        )
        self.activity = Activity.objects.create(
            title="State Contest",
            activity_type=Activity.Type.SINGER_CONTEST,
            is_locked=False,
        )
        self.session = create_vote_session(
            activity=self.activity,
            name="Popularity",
            passcode="1234",
            start_time=timezone.now() - timedelta(minutes=10),
            end_time=timezone.now() + timedelta(minutes=10),
        )

    def test_open_vote_session_is_idempotent(self):
        opened = open_vote_session(self.session, self.operator)
        self.assertTrue(opened.is_open)

        again = open_vote_session(self.session, self.operator)
        self.assertTrue(again.is_open)
        self.assertTrue(VoteSession.objects.get(pk=self.session.pk).is_open)

    def test_close_vote_session_is_idempotent(self):
        open_vote_session(self.session, self.operator)
        closed = close_vote_session(self.session, self.operator)
        self.assertFalse(closed.is_open)

        close_vote_session(self.session, self.operator)
        self.assertFalse(VoteSession.objects.get(pk=self.session.pk).is_open)

    def test_lock_vote_session_sets_locked_and_closed(self):
        open_vote_session(self.session, self.operator)
        locked = lock_vote_session(self.session, self.operator)
        self.assertTrue(locked.is_locked)
        self.assertFalse(locked.is_open)

        again = lock_vote_session(self.session, self.operator)
        self.assertTrue(again.is_locked)
        self.assertTrue(
            AuditLog.objects.filter(
                action_type=AuditLog.ActionType.RELOCK_RESULT,
                target=f"VoteSession:{self.session.pk}",
            ).exists()
        )

    def test_unlock_vote_session_clears_lock_and_preserves_state(self):
        lock_vote_session(self.session, self.operator)
        unlocked = unlock_vote_session(self.session, self.operator, note="fix typo")
        self.assertFalse(unlocked.is_locked)
        self.assertTrue(
            AuditLog.objects.filter(
                action_type=AuditLog.ActionType.UNLOCK_RESULT,
                target=f"VoteSession:{self.session.pk}",
                note="fix typo",
            ).exists()
        )

    def test_unlock_vote_session_is_idempotent(self):
        unlock_vote_session(self.session, self.operator)
        unlock_vote_session(self.session, self.operator)
        self.assertFalse(VoteSession.objects.get(pk=self.session.pk).is_locked)

    def test_open_locked_vote_session_is_denied(self):
        lock_vote_session(self.session, self.operator)
        with self.assertRaises(PermissionDenied):
            open_vote_session(self.session, self.operator)

    def test_activity_lock_blocks_child_state_mutations(self):
        with authority_write(ACTIVITY_STATE):
            Activity.objects.filter(pk=self.activity.pk).update(is_locked=True)
        for action in (
            open_vote_session,
            close_vote_session,
            lock_vote_session,
            unlock_vote_session,
        ):
            with self.assertRaises(PermissionDenied):
                action(self.session, self.operator)

        session = VoteSession.objects.get(pk=self.session.pk)
        self.assertFalse(session.is_open)
        self.assertFalse(session.is_locked)


class VoteSessionCreationAuthorityTests(TestCase):
    def setUp(self):
        self.activity = Activity.objects.create(
            title="Vote creation", activity_type=Activity.Type.SINGER_CONTEST
        )

    def _session_kwargs(self, name, **kwargs):
        now = timezone.now()
        return {
            "activity": self.activity,
            "name": name,
            "passcode": "1234",
            "start_time": now,
            "end_time": now + timedelta(minutes=10),
            **kwargs,
        }

    def test_vote_session_creation_rejects_open_initial_state_through_both_managers(self):
        for manager, name in (
            (VoteSession.objects, "Default manager open"),
            (VoteSession._base_manager, "Base manager open"),
        ):
            with self.subTest(manager=manager.name):
                with self.assertRaises(ValidationError):
                    manager.create(**self._session_kwargs(name, is_open=True))
                self.assertFalse(VoteSession.objects.filter(name=name).exists())

    def test_vote_session_bulk_create_rejects_locked_initial_state_through_both_managers(self):
        for manager, name in (
            (VoteSession.objects, "Default bulk locked"),
            (VoteSession._base_manager, "Base bulk locked"),
        ):
            with self.subTest(manager=manager.name):
                with self.assertRaises(ValidationError):
                    manager.bulk_create([VoteSession(**self._session_kwargs(name, is_locked=True))])
                self.assertFalse(VoteSession.objects.filter(name=name).exists())

    def test_vote_session_bulk_create_update_conflicts_rejects_state_change(self):
        session = VoteSession.objects.create(**self._session_kwargs("Conflict target"))

        with self.assertRaises(ValidationError):
            VoteSession.objects.bulk_create(
                [
                    VoteSession(
                        **self._session_kwargs("Conflict target", pk=session.pk, is_locked=True)
                    )
                ],
                update_conflicts=True,
                update_fields=["is_locked"],
                unique_fields=["pk"],
            )

        session.refresh_from_db()
        self.assertFalse(session.is_locked)

    def test_vote_session_bulk_create_positional_configuration_guard_through_both_managers(
        self,
    ):
        for manager, name in (
            (VoteSession.objects, "Default positional conflict target"),
            (VoteSession._base_manager, "Base positional conflict target"),
        ):
            with self.subTest(manager=manager.name):
                session = VoteSession.objects.create(**self._session_kwargs(name))
                with authority_write(VOTE_SESSION_STATE):
                    VoteSession.objects.filter(pk=session.pk).update(is_locked=True)

                with self.assertRaises(ValidationError):
                    manager.bulk_create(
                        [
                            VoteSession(
                                **self._session_kwargs(
                                    f"{name} bypass",
                                    pk=session.pk,
                                    is_test_data=session.is_test_data,
                                )
                            )
                        ],
                        None,
                        False,
                        True,
                        ["name"],
                        ["pk"],
                    )

                session.refresh_from_db()
                self.assertTrue(session.is_locked)
                self.assertEqual(session.name, name)

    def test_vote_session_bulk_create_update_conflicts_rejects_locked_configuration_change(self):
        session = VoteSession.objects.create(**self._session_kwargs("Original"))
        with authority_write(VOTE_SESSION_STATE):
            VoteSession.objects.filter(pk=session.pk).update(is_locked=True)

        with self.assertRaises(ValidationError):
            VoteSession.objects.bulk_create(
                [VoteSession(**self._session_kwargs("Bypass", pk=session.pk))],
                update_conflicts=True,
                update_fields=["name"],
                unique_fields=["pk"],
            )

        session.refresh_from_db()
        self.assertEqual(session.name, "Original")


class VoteSessionDeletionAuthorityTests(TestCase):
    def setUp(self):
        self.activity = Activity.objects.create(
            title="Vote deletion", activity_type=Activity.Type.SINGER_CONTEST
        )

    def _session(self, name, **kwargs):
        now = timezone.now()
        return VoteSession.objects.create(
            activity=self.activity,
            name=name,
            passcode="1234",
            start_time=now,
            end_time=now + timedelta(minutes=10),
            is_test_data=True,
            **kwargs,
        )

    def test_vote_session_delete_rejects_locked_and_unauthorized_manager_paths(self):
        direct = self._session("Direct")
        queryset = self._session("Queryset")
        base_queryset = self._session("Base queryset")
        with authority_write(VOTE_SESSION_STATE):
            VoteSession.objects.filter(pk=direct.pk).update(is_locked=True)

        with self.assertRaises(ValidationError):
            direct.delete()
        with self.assertRaises(ValidationError):
            VoteSession.objects.filter(pk=queryset.pk).delete()
        with self.assertRaises(ValidationError):
            VoteSession._base_manager.filter(pk=base_queryset.pk).delete()

        self.assertEqual(VoteSession.objects.filter(activity=self.activity).count(), 3)

    def test_vote_session_delete_allows_only_explicit_test_cleanup_scope(self):
        session = self._session("Cleanup")

        with self.assertRaises(ValidationError):
            session.delete()
        with authority_write("test_data.cleanup"):
            session.delete()

        self.assertFalse(VoteSession.objects.filter(pk=session.pk).exists())

    def test_clear_test_data_closes_and_unlocks_vote_sessions_before_cleanup(self):
        operator = User.objects.create_user(username="vote-cleanup", password="pass")
        session = self._session("Locked cleanup")
        with authority_write(VOTE_SESSION_STATE):
            VoteSession.objects.filter(pk=session.pk).update(is_locked=True)

        clear_activity_test_data(self.activity, operator=operator)

        self.assertFalse(VoteSession.objects.filter(pk=session.pk).exists())


class VoteEntryRateLimitTests(TestCase):
    def setUp(self):
        cache.clear()
        self.activity = Activity.objects.create(
            title="Contest",
            activity_type=Activity.Type.SINGER_CONTEST,
            is_test_mode=False,
        )
        self.session = create_vote_session(
            activity=self.activity,
            name="Popularity",
            passcode="1234",
            start_time=timezone.now() - timedelta(minutes=1),
            end_time=timezone.now() + timedelta(minutes=10),
            is_open=True,
        )

    def tearDown(self):
        cache.clear()

    def test_wrong_passcode_is_throttled_after_limit(self):
        url = reverse("voting:vote_entry", args=[self.session.pk])
        for _ in range(10):
            response = self.client.post(url, {"passcode": "wrong"}, REMOTE_ADDR="127.0.0.1")
            self.assertEqual(response.status_code, 200)
            self.assertContains(response, "口令错误")

        throttled = self.client.post(url, {"passcode": "wrong"}, REMOTE_ADDR="127.0.0.1")
        self.assertEqual(throttled.status_code, 200)
        self.assertContains(throttled, "尝试次数过多")

    def test_throttle_is_scoped_to_the_vote_session(self):
        other = create_vote_session(
            activity=self.activity,
            name="Other",
            passcode="5678",
            start_time=timezone.now() - timedelta(minutes=1),
            end_time=timezone.now() + timedelta(minutes=10),
            is_open=True,
        )
        url = reverse("voting:vote_entry", args=[self.session.pk])
        for _ in range(10):
            self.client.post(url, {"passcode": "wrong"}, REMOTE_ADDR="127.0.0.1")

        other_response = self.client.post(
            reverse("voting:vote_entry", args=[other.pk]),
            {"passcode": "wrong"},
            REMOTE_ADDR="127.0.0.1",
        )
        self.assertEqual(other_response.status_code, 200)
        self.assertContains(other_response, "口令错误")

    def test_vote_passcode_uses_shared_database_throttle(self):
        from common.models import RateLimitBucket

        url = reverse("voting:vote_entry", args=[self.session.pk])
        with self.settings(RATE_LIMIT_BACKEND="database"):
            for _ in range(11):
                self.client.post(url, {"passcode": "wrong"}, REMOTE_ADDR="198.51.100.7")

        self.assertEqual(RateLimitBucket.objects.get().count, 11)
