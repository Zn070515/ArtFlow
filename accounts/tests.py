import os
import threading
from datetime import datetime
from datetime import timezone as dt_timezone
from io import StringIO
from unittest import skipUnless
from unittest.mock import patch

from django.contrib import admin
from common.models import AuditLog
from django.core.cache import cache
from django.core.exceptions import PermissionDenied, ValidationError
from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import close_old_connections, connection
from django.db.models import Q
from django.test import RequestFactory, TestCase, TransactionTestCase, override_settings
from django.urls import reverse
from django.utils import timezone

from .models import User
from .admin import CustomUserAdmin
from .services import (
    admin_verification_is_valid,
    change_user_role,
    expire_admin_verification,
    mark_admin_verified,
    set_user_active,
)


class LoginModeTests(TestCase):
    def setUp(self):
        self.participant = User.objects.create_user(
            username="participant",
            password="pass12345",
            role=User.Role.PARTICIPANT,
        )
        self.admin = User.objects.create_user(
            username="admin",
            password="pass12345",
            role=User.Role.ADMIN,
        )

    def test_normal_login_allows_non_admin_user(self):
        response = self.client.post(
            reverse("accounts:login"),
            {
                "login_mode": "normal",
                "username": "participant",
                "password": "pass12345",
            },
        )
        self.assertEqual(response.status_code, 302)
        self.assertEqual(response["Location"], reverse("public_portal:home"))

    def test_normal_login_rejects_admin_user(self):
        response = self.client.post(
            reverse("accounts:login"),
            {
                "login_mode": "normal",
                "username": "admin",
                "password": "pass12345",
            },
        )
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "管理员账号请使用管理员登录入口。")

    @override_settings(ADMIN_LOGIN_KEY="secret-key")
    def test_admin_login_requires_correct_key(self):
        response = self.client.post(
            reverse("accounts:admin_login"),
            {
                "username": "admin",
                "password": "pass12345",
                "admin_key": "wrong-key",
            },
        )
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "管理员密钥错误。")

    @override_settings(ADMIN_LOGIN_KEY="secret-key")
    def test_admin_login_redirects_admin_to_staff_dashboard(self):
        response = self.client.post(
            reverse("accounts:admin_login"),
            {
                "username": "admin",
                "password": "pass12345",
                "admin_key": "secret-key",
            },
        )
        self.assertEqual(response.status_code, 302)
        self.assertEqual(response["Location"], reverse("staff:dashboard"))

    @override_settings(ADMIN_LOGIN_KEY="secret-key")
    def test_admin_login_rejects_non_admin_user(self):
        response = self.client.post(
            reverse("accounts:admin_login"),
            {
                "username": "participant",
                "password": "pass12345",
                "admin_key": "secret-key",
            },
        )
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "该账号不是管理员账号。")

    @override_settings(ADMIN_LOGIN_KEY="secret-key")
    def test_admin_login_sets_verified_session_marker(self):
        response = self.client.post(
            reverse("accounts:admin_login"),
            {
                "username": "admin",
                "password": "pass12345",
                "admin_key": "secret-key",
            },
        )
        self.assertEqual(response.status_code, 302)
        session = self.client.session
        self.assertTrue(session.get("artflow_admin_verified"))
        self.assertIsNotNone(session.get("artflow_admin_verified_at"))

    def test_normal_login_page_links_to_admin_login(self):
        response = self.client.get(reverse("accounts:login"))
        self.assertContains(response, reverse("accounts:admin_login"))
        self.assertContains(response, "管理员登录")


class AdminVerificationTTLTests(TestCase):
    """§17 P1 — the elevated admin verification marker must expire (bounded TTL)."""

    def setUp(self):
        self.admin = User.objects.create_user(
            username="admin",
            password="pass12345",
            role=User.Role.ADMIN,
        )

    @override_settings(ADMIN_LOGIN_KEY="secret-key", ADMIN_VERIFICATION_TTL_SECONDS=3600)
    def test_mark_admin_verified_sets_marker_and_timestamp(self):
        session: dict = {}
        mark_admin_verified(session)
        self.assertTrue(session["artflow_admin_verified"])
        self.assertIsNotNone(session["artflow_admin_verified_at"])
        self.assertTrue(admin_verification_is_valid(session))

    @override_settings(ADMIN_LOGIN_KEY="secret-key", ADMIN_VERIFICATION_TTL_SECONDS=3600)
    def test_verification_is_invalid_without_marker(self):
        self.assertFalse(admin_verification_is_valid({}))
        self.assertFalse(admin_verification_is_valid({"artflow_admin_verified": True}))
        self.assertFalse(admin_verification_is_valid({"artflow_admin_verified_at": "x"}))

    @override_settings(ADMIN_LOGIN_KEY="secret-key", ADMIN_VERIFICATION_TTL_SECONDS=3600)
    def test_verification_expires_after_ttl_window(self):
        session = {"artflow_admin_verified": True}
        with patch("accounts.services.timezone.now") as mock_now:
            mock_now.return_value = datetime(2026, 8, 29, 12, 0, 0, tzinfo=dt_timezone.utc)
            mark_admin_verified(session)
            mid = mock_now.return_value
            mock_now.return_value = mid + timezone.timedelta(seconds=1800)  # type: ignore[attr-defined]
            self.assertTrue(admin_verification_is_valid(session))
            mock_now.return_value = mid + timezone.timedelta(seconds=3601)  # type: ignore[attr-defined]
            self.assertFalse(admin_verification_is_valid(session))

    @override_settings(ADMIN_LOGIN_KEY="secret-key", ADMIN_VERIFICATION_TTL_SECONDS=3600)
    def test_expire_admin_verification_drops_marker(self):
        session = {
            "artflow_admin_verified": True,
            "artflow_admin_verified_at": "2026-08-29T12:00:00+00:00",
        }
        expire_admin_verification(session)
        self.assertNotIn("artflow_admin_verified", session)
        self.assertNotIn("artflow_admin_verified_at", session)
        self.assertFalse(admin_verification_is_valid(session))

    @override_settings(ADMIN_LOGIN_KEY="secret-key", ADMIN_VERIFICATION_TTL_SECONDS=3600)
    def test_admin_required_redirects_when_verification_expired(self):
        # Log in as admin, clear the elevated marker, then hit an @admin_required view.
        self.client.force_login(self.admin)
        session = self.client.session
        session["artflow_admin_verified"] = False
        session.save()
        target = reverse("staff:activity_create")
        response = self.client.get(target)
        self.assertEqual(response.status_code, 302)
        self.assertTrue(response["Location"].startswith(f"{reverse('accounts:admin_login')}?"))
        self.assertIn(f"next={target}", response["Location"])

    @override_settings(ADMIN_LOGIN_KEY="secret-key")
    def test_admin_login_uses_mark_verified_helper(self):
        response = self.client.post(
            reverse("accounts:admin_login"),
            {"username": "admin", "password": "pass12345", "admin_key": "secret-key"},
        )
        self.assertEqual(response.status_code, 302)
        session = self.client.session
        self.assertTrue(session.get("artflow_admin_verified"))
        self.assertTrue(admin_verification_is_valid(session))


class AdminLoginRateLimitTests(TestCase):
    def setUp(self):
        cache.clear()
        self.admin = User.objects.create_user(
            username="admin",
            password="pass12345",
            role=User.Role.ADMIN,
        )

    def tearDown(self):
        cache.clear()

    @override_settings(ADMIN_LOGIN_KEY="secret-key")
    def test_admin_login_throttles_after_many_failures(self):
        url = reverse("accounts:admin_login")
        for _ in range(10):
            response = self.client.post(
                url,
                {"username": "admin", "password": "pass12345", "admin_key": "wrong"},
            )
            self.assertEqual(response.status_code, 200)

        throttled = self.client.post(
            url,
            {"username": "admin", "password": "pass12345", "admin_key": "wrong"},
        )
        self.assertEqual(throttled.status_code, 200)
        self.assertContains(throttled, "尝试次数过多")

    @override_settings(ADMIN_LOGIN_KEY="secret-key")
    def test_correct_credentials_still_log_in_when_under_limit(self):
        url = reverse("accounts:admin_login")
        for _ in range(3):
            self.client.post(
                url,
                {"username": "admin", "password": "wrong", "admin_key": "wrong"},
            )
        response = self.client.post(
            url,
            {"username": "admin", "password": "pass12345", "admin_key": "secret-key"},
        )
        self.assertEqual(response.status_code, 302)
        self.assertEqual(response["Location"], reverse("staff:dashboard"))


class UserPermissionSynchronizationTests(TestCase):
    def test_service_demoting_staff_user_clears_django_staff_flag(self):
        actor = User.objects.create_user(
            username="authority-admin",
            password="pass12345",
            role=User.Role.ADMIN,
        )
        user = User.objects.create_user(
            username="demoted-staff",
            password="pass12345",
            role=User.Role.STAFF,
        )
        self.assertTrue(user.is_staff)

        change_user_role(target=user, new_role=User.Role.PARTICIPANT, actor=actor)

        user.refresh_from_db()
        self.assertFalse(user.is_staff)

    def test_superuser_remains_staff_when_role_is_participant(self):
        user = User.objects.create_superuser(
            username="superuser",
            password="pass12345",
            email="superuser@example.com",
            role=User.Role.PARTICIPANT,
        )

        user.refresh_from_db()
        self.assertTrue(user.is_staff)


class SeedDevAdminCommandTests(TestCase):
    @patch("getpass.getpass", return_value="")
    @patch.dict(os.environ, {"DEV_ADMIN_PASSWORD": ""})
    def test_seed_dev_admin_requires_a_nonempty_password(self, _getpass):
        with self.assertRaisesMessage(CommandError, "A development admin password is required."):
            call_command("seed_dev_admin")

    @patch("getpass.getpass", return_value="hidden-input-password")
    @patch.dict(os.environ, {"DEV_ADMIN_PASSWORD": ""})
    def test_seed_dev_admin_updates_existing_admin_from_hidden_input(self, _getpass):
        user = User.objects.create_user(
            username="existing-admin",
            password="old-password",
            role=User.Role.PARTICIPANT,
        )
        output = StringIO()

        call_command("seed_dev_admin", "--username", user.username, stdout=output)

        user.refresh_from_db()
        self.assertEqual(user.role, User.Role.ADMIN)
        self.assertTrue(user.is_staff)
        self.assertTrue(user.is_superuser)
        self.assertTrue(user.check_password("hidden-input-password"))
        self.assertEqual(output.getvalue(), "Updated development admin: existing-admin\n")
        self.assertNotIn("hidden-input-password", output.getvalue())


class EffectiveAdminAuthorityTests(TestCase):
    """The ``is_admin`` authority and the last-admin guard must agree.

    An effective admin is ``active AND (role == ADMIN OR is_superuser)``. The
    guard must count superusers too, and the mutation must re-read the actor's
    authority from the database instead of trusting a stale Python object.
    """

    def setUp(self):
        self.super_admin = User.objects.create_superuser(
            username="super-admin",
            email="super@example.com",
            password="pass12345",
            role=User.Role.PARTICIPANT,
        )
        self.participant = User.objects.create_user(
            username="participant-x", password="pass12345", role=User.Role.PARTICIPANT
        )

    def test_superuser_counts_as_effective_admin_for_last_admin_guard(self):
        # The superuser is an effective admin even with a participant role, so a
        # real role-based admin may be demoted without leaving zero admins. The
        # old guard only counted role == ADMIN and rejected this correctly.
        real_admin = User.objects.create_user(
            username="real-admin", password="pass12345", role=User.Role.ADMIN
        )
        change_user_role(target=real_admin, new_role=User.Role.PARTICIPANT, actor=self.super_admin)
        real_admin.refresh_from_db()
        self.assertEqual(real_admin.role, User.Role.PARTICIPANT)
        self.assertTrue(self.super_admin.is_admin)
        log = AuditLog.objects.filter(
            action_type=AuditLog.ActionType.UPDATE_PERMISSION,
            operator=self.super_admin,
            target=f"User:{real_admin.pk}",
        ).get()
        self.assertEqual(log.old_value, User.Role.ADMIN)
        self.assertEqual(log.new_value, User.Role.PARTICIPANT)

    def test_revoked_actor_cannot_use_stale_admin_authority(self):
        # Demote the actor to participant (revoker remains admin). The actor
        # object in memory still says ADMIN; the service must reject using that
        # stale authority to mutate a third user.
        revoker = User.objects.create_user(
            username="revoker", password="pass12345", role=User.Role.ADMIN
        )
        actor = User.objects.create_user(
            username="actor", password="pass12345", role=User.Role.ADMIN
        )
        change_user_role(target=actor, new_role=User.Role.PARTICIPANT, actor=revoker)
        stale_actor = actor
        with self.assertRaises(PermissionDenied):
            change_user_role(target=self.participant, new_role=User.Role.STAFF, actor=stale_actor)
        self.participant.refresh_from_db()
        self.assertEqual(self.participant.role, User.Role.PARTICIPANT)

    def test_last_effective_admin_cannot_be_demoted(self):
        # Only ``alone`` is effective after the service deactivates the superuser.
        alone = User.objects.create_user(
            username="only-admin", password="pass12345", role=User.Role.ADMIN
        )
        set_user_active(target=self.super_admin, is_active=False, actor=alone)
        with self.assertRaises(ValidationError):
            change_user_role(target=alone, new_role=User.Role.PARTICIPANT, actor=alone)
        alone.refresh_from_db()
        self.assertEqual(alone.role, User.Role.ADMIN)


class AccountAuthorityBoundaryTests(TestCase):
    """Only audited account services may change security-bearing User fields."""

    def setUp(self):
        self.admin = User.objects.create_user(
            username="account-authority-admin",
            password="pass12345",
            role=User.Role.ADMIN,
        )
        self.target = User.objects.create_user(
            username="account-authority-target",
            password="pass12345",
            role=User.Role.PARTICIPANT,
        )

    def test_instance_save_rejects_role_active_and_superuser_changes(self):
        self.target.role = User.Role.STAFF
        with self.assertRaises(ValidationError):
            self.target.save()

        self.target.refresh_from_db()
        self.target.is_active = False
        with self.assertRaises(ValidationError):
            self.target.save()

        self.target.refresh_from_db()
        self.target.is_superuser = True
        with self.assertRaises(ValidationError):
            self.target.save()

    def test_queryset_update_rejects_role_active_and_superuser_changes(self):
        for field, value in (
            ("role", User.Role.STAFF),
            ("is_active", False),
            ("is_superuser", True),
        ):
            with self.subTest(field=field), self.assertRaises(ValidationError):
                User.objects.filter(pk=self.target.pk).update(**{field: value})

    def test_base_manager_update_rejects_role_active_and_superuser_changes(self):
        for field, value in (
            ("role", User.Role.STAFF),
            ("is_active", False),
            ("is_superuser", True),
        ):
            with self.subTest(field=field), self.assertRaises(ValidationError):
                User._base_manager.filter(pk=self.target.pk).update(**{field: value})

    def test_bulk_update_rejects_role_active_and_superuser_changes(self):
        for field, value in (
            ("role", User.Role.STAFF),
            ("is_active", False),
            ("is_superuser", True),
        ):
            self.target.refresh_from_db()
            setattr(self.target, field, value)
            with self.subTest(field=field), self.assertRaises(ValidationError):
                User.objects.bulk_update([self.target], [field])

    def test_admin_change_form_keeps_protected_account_fields_readonly(self):
        request = RequestFactory().get("/admin/accounts/user/")
        request.user = User.objects.create_superuser(
            username="account-authority-superuser",
            email="authority@example.com",
            password="pass12345",
        )
        form_class = CustomUserAdmin(User, admin.site).get_form(request, self.target, change=True)
        self.assertNotIn("role", form_class.base_fields)
        self.assertNotIn("is_active", form_class.base_fields)
        self.assertNotIn("is_superuser", form_class.base_fields)

    def test_role_and_active_services_change_authority_fields_and_audit(self):
        changed = change_user_role(
            target=self.target,
            new_role=User.Role.STAFF,
            actor=self.admin,
        )
        self.assertEqual(changed.role, User.Role.STAFF)
        role_audit = AuditLog.objects.get(target=f"User:{self.target.pk}", old_value="participant")
        self.assertEqual(role_audit.new_value, "staff")

        changed = set_user_active(target=self.target, is_active=False, actor=self.admin)
        self.assertFalse(changed.is_active)
        active_audit = AuditLog.objects.get(target=f"User:{self.target.pk}", old_value="active=True")
        self.assertEqual(active_audit.new_value, "active=False")


@skipUnless(connection.vendor == "postgresql", "requires PostgreSQL row locks")
class AdminAuthorityConcurrencyTests(TransactionTestCase):
    """Concurrent admin mutations must never leave zero effective admins."""

    def _effective_admin_count(self) -> int:
        return (
            User.objects.filter(is_active=True)
            .filter(Q(role=User.Role.ADMIN) | Q(is_superuser=True))
            .count()
        )

    def test_concurrent_mutual_demotion_keeps_at_least_one_admin(self):
        admin_a = User.objects.create_user(
            username="admin-a", password="pass12345", role=User.Role.ADMIN
        )
        admin_b = User.objects.create_user(
            username="admin-b", password="pass12345", role=User.Role.ADMIN
        )
        results: dict[str, str] = {}

        def demote_b():
            close_old_connections()
            try:
                change_user_role(target=admin_b, new_role=User.Role.PARTICIPANT, actor=admin_a)
                results["b"] = "ok"
            except (ValidationError, PermissionDenied):
                results["b"] = "rejected"
            except Exception:
                results["b"] = "error"
            finally:
                close_old_connections()

        def demote_a():
            close_old_connections()
            try:
                change_user_role(target=admin_a, new_role=User.Role.PARTICIPANT, actor=admin_b)
                results["a"] = "ok"
            except (ValidationError, PermissionDenied):
                results["a"] = "rejected"
            except Exception:
                results["a"] = "error"
            finally:
                close_old_connections()

        threads = [threading.Thread(target=demote_b), threading.Thread(target=demote_a)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=20)

        self.assertGreaterEqual(self._effective_admin_count(), 1)
        self.assertLessEqual(list(results.values()).count("ok"), 1)

    def test_concurrent_mutual_deactivation_keeps_at_least_one_admin(self):
        admin_a = User.objects.create_user(
            username="deact-a", password="pass12345", role=User.Role.ADMIN
        )
        admin_b = User.objects.create_user(
            username="deact-b", password="pass12345", role=User.Role.ADMIN
        )
        results: dict[str, str] = {}

        def deactivate_b():
            close_old_connections()
            try:
                set_user_active(target=admin_b, is_active=False, actor=admin_a)
                results["b"] = "ok"
            except (ValidationError, PermissionDenied):
                results["b"] = "rejected"
            except Exception:
                results["b"] = "error"
            finally:
                close_old_connections()

        def deactivate_a():
            close_old_connections()
            try:
                set_user_active(target=admin_a, is_active=False, actor=admin_b)
                results["a"] = "ok"
            except (ValidationError, PermissionDenied):
                results["a"] = "rejected"
            except Exception:
                results["a"] = "error"
            finally:
                close_old_connections()

        threads = [threading.Thread(target=deactivate_b), threading.Thread(target=deactivate_a)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=20)

        self.assertGreaterEqual(self._effective_admin_count(), 1)
        self.assertLessEqual(list(results.values()).count("ok"), 1)
