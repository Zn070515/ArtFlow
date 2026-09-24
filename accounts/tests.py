import os
import threading
from datetime import datetime, timedelta
from datetime import timezone as dt_timezone
from io import StringIO
from unittest import skipUnless
from unittest.mock import patch

from common.authority import ACCOUNT_AUTHORITY, authority_write
from common.models import AuditLog
from django.contrib import admin
from django.core.cache import cache
from django.core.exceptions import PermissionDenied, ValidationError
from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import DatabaseError, close_old_connections, connection, transaction
from django.db.models import Q
from django.test import Client, RequestFactory, TestCase, TransactionTestCase, override_settings
from django.urls import reverse
from django.utils import timezone

from .admin import CustomUserAdmin
from .models import InstallationState, User
from .services import (
    admin_verification_is_valid,
    change_user_role,
    expire_admin_verification,
    installation_provisioning_status,
    mark_admin_verified,
    provision_first_admin,
    require_current_admin,
    require_current_staff,
    set_user_active,
)


def create_provisioned_user(*args, **kwargs):
    with authority_write(ACCOUNT_AUTHORITY):
        return User.objects.create_user(*args, **kwargs)


class LoginModeTests(TestCase):
    def setUp(self):
        self.participant = User.objects.create_user(
            username="participant",
            password="pass12345",
            role=User.Role.PARTICIPANT,
        )
        self.admin = create_provisioned_user(
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


class ParticipantLoginRateLimitTests(TestCase):
    def setUp(self):
        cache.clear()
        self.participant = User.objects.create_user(
            username="rate-limited-participant",
            password="pass12345",
            role=User.Role.PARTICIPANT,
        )

    def tearDown(self):
        cache.clear()

    def test_participant_login_is_throttled_before_authentication(self):
        url = reverse("accounts:login")
        payload = {
            "login_mode": "normal",
            "username": self.participant.username,
            "password": "wrong-password",
        }

        with patch("accounts.views.ParticipantLoginForm.is_valid", return_value=False) as is_valid:
            for _ in range(10):
                response = self.client.post(url, payload, REMOTE_ADDR="198.51.100.10")
                self.assertEqual(response.status_code, 200)

            throttled = self.client.post(url, payload, REMOTE_ADDR="198.51.100.10")

        self.assertEqual(throttled.status_code, 200)
        self.assertContains(throttled, "尝试次数过多")
        self.assertEqual(is_valid.call_count, 10)

    @override_settings(TRUST_X_FORWARDED_FOR=True)
    def test_participant_login_uses_the_forwarded_client_ip_when_trusted(self):
        url = reverse("accounts:login")
        invalid_payload = {
            "login_mode": "normal",
            "username": self.participant.username,
            "password": "wrong-password",
        }
        for _ in range(10):
            self.client.post(
                url,
                invalid_payload,
                REMOTE_ADDR="10.0.0.5",
                HTTP_X_FORWARDED_FOR="198.51.100.10",
            )

        response = self.client.post(
            url,
            {
                **invalid_payload,
                "password": "pass12345",
            },
            REMOTE_ADDR="10.0.0.5",
            HTTP_X_FORWARDED_FOR="198.51.100.11",
        )

        self.assertEqual(response.status_code, 302)
        self.assertEqual(response["Location"], reverse("public_portal:home"))


class RegistrationRateLimitTests(TestCase):
    def setUp(self):
        cache.clear()

    def tearDown(self):
        cache.clear()

    def test_registration_is_throttled_before_form_processing(self):
        url = reverse("accounts:register")
        payload = {
            "username": "new-student",
            "password1": "pass12345",
            "password2": "different-password",
        }

        with patch("accounts.views.RegisterForm.is_valid", return_value=False) as is_valid:
            for _ in range(10):
                response = self.client.post(url, payload, REMOTE_ADDR="198.51.100.20")
                self.assertEqual(response.status_code, 200)

            before_throttled_attempt = User.objects.count()
            throttled = self.client.post(url, payload, REMOTE_ADDR="198.51.100.20")

        self.assertEqual(throttled.status_code, 200)
        self.assertContains(throttled, "尝试次数过多")
        self.assertEqual(User.objects.count(), before_throttled_attempt)
        self.assertEqual(is_valid.call_count, 10)


class AdminVerificationTTLTests(TestCase):
    """§17 P1 — the elevated admin verification marker must expire (bounded TTL)."""

    def setUp(self):
        self.admin = create_provisioned_user(
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
            mock_now.return_value = mid + timedelta(seconds=1800)
            self.assertTrue(admin_verification_is_valid(session))
            mock_now.return_value = mid + timedelta(seconds=3601)
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
        self.admin = create_provisioned_user(
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

    @override_settings(ADMIN_LOGIN_KEY="secret-key", RATE_LIMIT_BACKEND="database")
    def test_admin_login_uses_shared_database_throttle(self):
        from common.models import RateLimitBucket

        url = reverse("accounts:admin_login")
        for _ in range(11):
            self.client.post(
                url,
                {"username": "admin", "password": "pass12345", "admin_key": "wrong"},
                REMOTE_ADDR="198.51.100.7",
            )

        bucket = RateLimitBucket.objects.get()
        self.assertEqual(bucket.count, 11)


class DatabaseRateLimitTests(TransactionTestCase):
    @override_settings(RATE_LIMIT_BACKEND="database")
    def test_database_allow_removes_only_a_bounded_expired_batch(self):
        from common import rate_limit
        from common.models import RateLimitBucket

        now = timezone.now()
        for index in range(3):
            RateLimitBucket.objects.create(
                key=f"{index:064x}",
                window_started_at=now - timedelta(minutes=10),
                count=1,
                expires_at=now - timedelta(seconds=1),
            )
        active_bucket = RateLimitBucket.objects.create(
            key="f" * 64,
            window_started_at=now,
            count=1,
            expires_at=now + timedelta(minutes=5),
        )

        with patch.object(rate_limit, "_CLEANUP_BATCH_SIZE", 2):
            rate_limit.allow("new-public-key", limit=1, window_seconds=300)

        self.assertEqual(RateLimitBucket.objects.filter(expires_at__lte=now).count(), 1)
        self.assertTrue(RateLimitBucket.objects.filter(pk=active_bucket.pk).exists())
        self.assertEqual(RateLimitBucket.objects.filter(expires_at__gt=now).count(), 2)

    @override_settings(RATE_LIMIT_BACKEND="database")
    def test_cleanup_database_error_does_not_break_outer_transaction(self):
        from common import rate_limit
        from common.models import RateLimitBucket

        now = timezone.now()
        expired_bucket = RateLimitBucket.objects.create(
            key="e" * 64,
            window_started_at=now - timedelta(minutes=10),
            count=1,
            expires_at=now - timedelta(seconds=1),
        )
        quoted_table = connection.ops.quote_name(RateLimitBucket._meta.db_table)

        def fail_cleanup_delete(execute, sql, params, many, context):
            if sql.lstrip().upper().startswith("DELETE") and quoted_table in sql:
                raise DatabaseError("injected cleanup failure")
            return execute(sql, params, many, context)

        with transaction.atomic():
            with connection.execute_wrapper(fail_cleanup_delete):
                decision = rate_limit.allow("successful-public-key", limit=1, window_seconds=300)

            allowed_bucket = RateLimitBucket.objects.exclude(pk=expired_bucket.pk).get()
            self.assertEqual(allowed_bucket.count, 1)

        self.assertTrue(decision.allowed)
        self.assertTrue(RateLimitBucket.objects.filter(pk=expired_bucket.pk).exists())
        self.assertTrue(RateLimitBucket.objects.filter(pk=allowed_bucket.pk).exists())

    @override_settings(RATE_LIMIT_BACKEND="database")
    def test_database_bucket_is_shared_across_connection_boundaries(self):
        from common import rate_limit
        from common.models import RateLimitBucket

        first = rate_limit.allow("shared-worker-key", limit=2, window_seconds=300)
        connection.close()
        second = rate_limit.allow("shared-worker-key", limit=2, window_seconds=300)
        connection.close()
        third = rate_limit.allow("shared-worker-key", limit=2, window_seconds=300)

        self.assertEqual(
            [first.allowed, second.allowed, third.allowed],
            [True, True, False],
        )
        self.assertEqual(RateLimitBucket.objects.get().count, 3)
        self.assertGreater(third.retry_after_seconds, 0)

    @override_settings(RATE_LIMIT_BACKEND="database")
    def test_expired_database_bucket_restarts_its_window(self):
        from common import rate_limit
        from common.models import RateLimitBucket

        rate_limit.allow("expired-window-key", limit=1, window_seconds=300)
        RateLimitBucket.objects.all().update(expires_at=timezone.now() - timedelta(seconds=1))

        decision = rate_limit.allow("expired-window-key", limit=1, window_seconds=300)
        bucket = RateLimitBucket.objects.get()

        self.assertTrue(decision.allowed)
        self.assertEqual(bucket.count, 1)

    @override_settings(RATE_LIMIT_BACKEND="database")
    def test_rate_limit_decision_contains_only_allowance_and_retry_metadata(self):
        from common import rate_limit

        rate_limit.allow("non-sensitive-result-key", limit=1, window_seconds=300)
        decision = rate_limit.allow("non-sensitive-result-key", limit=1, window_seconds=300)

        self.assertFalse(decision.allowed)
        self.assertGreater(decision.retry_after_seconds, 0)
        self.assertEqual(set(vars(decision)), {"allowed", "retry_after_seconds"})


@skipUnless(connection.vendor == "postgresql", "requires PostgreSQL atomic upsert")
class DatabaseRateLimitConcurrencyTests(TransactionTestCase):
    @override_settings(RATE_LIMIT_BACKEND="database")
    def test_concurrent_workers_allow_only_the_configured_limit(self):
        from common import rate_limit

        start = threading.Barrier(2)
        outcomes: list[bool] = []
        errors: list[Exception] = []

        def hit_from_worker():
            close_old_connections()
            try:
                start.wait(timeout=10)
                outcomes.append(
                    rate_limit.allow("concurrent-worker-key", limit=1, window_seconds=300).allowed
                )
            except Exception as error:  # pragma: no cover - diagnostic assertion below
                errors.append(error)
            finally:
                close_old_connections()

        workers = [threading.Thread(target=hit_from_worker) for _ in range(2)]
        for worker in workers:
            worker.start()
        for worker in workers:
            worker.join(timeout=20)

        self.assertFalse(errors)
        self.assertCountEqual(outcomes, [True, False])


class UserPermissionSynchronizationTests(TestCase):
    def test_service_demoting_staff_user_clears_django_staff_flag(self):
        actor = create_provisioned_user(
            username="authority-admin",
            password="pass12345",
            role=User.Role.ADMIN,
        )
        user = create_provisioned_user(
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


class FirstAdminSetupViewTests(TestCase):
    setup_password = "a-strong-bootstrap-pass"

    def setup_payload(self, **overrides):
        payload = {
            "username": "event-admin",
            "password": self.setup_password,
            "password_confirm": self.setup_password,
            "setup_key": "setup-secret",
        }
        payload.update(overrides)
        return payload

    @override_settings(ADMIN_LOGIN_KEY="setup-secret")
    def test_required_installation_renders_one_time_setup_form(self):
        response = self.client.get(reverse("accounts:first_admin_setup"))

        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "首次初始化")
        self.assertContains(response, 'name="setup_key"')
        self.assertContains(response, 'name="password_confirm"')

    @override_settings(ADMIN_LOGIN_KEY="setup-secret")
    def test_wrong_setup_key_does_not_provision(self):
        response = self.client.post(
            reverse("accounts:first_admin_setup"),
            self.setup_payload(setup_key="wrong"),
        )

        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "管理员密钥错误")
        self.assertEqual(User.objects.count(), 0)

    @override_settings(ADMIN_LOGIN_KEY="setup-secret")
    def test_placeholder_setup_key_does_not_provision(self):
        with self.settings(ADMIN_LOGIN_KEY="change-me-with-a-local-admin-login-key"):
            response = self.client.post(
                reverse("accounts:first_admin_setup"),
                self.setup_payload(setup_key="change-me-with-a-local-admin-login-key"),
            )

        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "管理员密钥尚未安全配置")
        self.assertEqual(User.objects.count(), 0)

    @override_settings(ADMIN_LOGIN_KEY="setup-secret")
    def test_password_confirmation_mismatch_does_not_provision(self):
        response = self.client.post(
            reverse("accounts:first_admin_setup"),
            self.setup_payload(password_confirm="different-password"),
        )

        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "两次输入的密码不一致")
        self.assertEqual(User.objects.count(), 0)

    @override_settings(ADMIN_LOGIN_KEY="setup-secret")
    def test_valid_setup_provisions_and_redirects_to_staff(self):
        response = self.client.post(
            reverse("accounts:first_admin_setup"),
            self.setup_payload(),
        )

        self.assertRedirects(response, reverse("staff:dashboard"), fetch_redirect_response=False)
        user = User.objects.get(username="event-admin")
        self.assertTrue(user.is_admin)
        self.assertFalse(user.is_superuser)
        self.assertTrue(self.client.session.get("artflow_admin_verified"))
        self.assertEqual(InstallationState.objects.get().initialized_at is None, False)

    @override_settings(ADMIN_LOGIN_KEY="setup-secret")
    def test_completed_installation_hides_setup_endpoint(self):
        provision_first_admin(username="event-admin", password=self.setup_password)

        response = self.client.get(reverse("accounts:first_admin_setup"))

        self.assertEqual(response.status_code, 404)

    @override_settings(ADMIN_LOGIN_KEY="setup-secret")
    def test_uninitialized_installation_with_existing_admin_hides_setup_endpoint(self):
        create_provisioned_user(
            username="legacy-admin",
            password=self.setup_password,
            role=User.Role.ADMIN,
        )

        response = self.client.get(reverse("accounts:first_admin_setup"))

        self.assertEqual(response.status_code, 404)

    @override_settings(ADMIN_LOGIN_KEY="setup-secret")
    def test_setup_post_requires_csrf_token(self):
        client = Client(enforce_csrf_checks=True)

        response = client.post(
            reverse("accounts:first_admin_setup"),
            self.setup_payload(),
        )

        self.assertEqual(response.status_code, 403)
        self.assertEqual(User.objects.count(), 0)


class FirstAdminProvisioningTests(TestCase):
    def setUp(self):
        self.state = InstallationState.objects.get(pk=InstallationState.SINGLETON_PK)

    def test_provisioning_status_is_required_before_and_complete_after_bootstrap(self):
        self.assertEqual(installation_provisioning_status(), "required")

        provision_first_admin(username="first-admin", password="a-strong-bootstrap-pass")

        self.assertEqual(installation_provisioning_status(), "complete")

    def test_first_provisioning_creates_a_least_privilege_admin_once(self):
        user = provision_first_admin(username="first-admin", password="a-strong-bootstrap-pass")

        user.refresh_from_db()
        self.state.refresh_from_db()
        self.assertEqual(user.role, User.Role.ADMIN)
        self.assertTrue(user.is_active)
        self.assertTrue(user.is_staff)
        self.assertFalse(user.is_superuser)
        self.assertTrue(user.check_password("a-strong-bootstrap-pass"))
        self.assertIsNotNone(self.state.initialized_at)
        self.assertTrue(
            AuditLog.objects.filter(
                action_type=AuditLog.ActionType.INITIAL_ADMIN_PROVISION,
                operator__isnull=True,
                target=f"User:{user.pk}",
            ).exists()
        )
        audit = AuditLog.objects.get(action_type=AuditLog.ActionType.INITIAL_ADMIN_PROVISION)
        self.assertNotIn("a-strong-bootstrap-pass", audit.new_value + audit.note)

    def test_provisioning_is_one_time_and_never_resets_the_first_admin(self):
        user = provision_first_admin(username="first-admin", password="a-strong-bootstrap-pass")

        with self.assertRaisesMessage(ValidationError, "首次管理员 provisioning 已完成"):
            provision_first_admin(username="replacement", password="another-strong-pass")

        self.assertEqual(User.objects.count(), 1)
        self.assertEqual(User.objects.get().pk, user.pk)

    def test_existing_effective_admin_blocks_uninitialized_state(self):
        existing = create_provisioned_user(
            username="legacy-admin",
            password="a-strong-bootstrap-pass",
            role=User.Role.ADMIN,
        )

        with self.assertRaisesMessage(ValidationError, "已有有效管理员"):
            provision_first_admin(username="replacement", password="another-strong-pass")

        self.state.refresh_from_db()
        self.assertIsNone(self.state.initialized_at)
        self.assertEqual(User.objects.get().pk, existing.pk)

    def test_invalid_username_and_password_are_rejected_without_mutation(self):
        with self.assertRaisesMessage(ValidationError, "用户名不能为空"):
            provision_first_admin(username="  ", password="a-strong-bootstrap-pass")
        with self.assertRaisesMessage(ValidationError, "密码不能为空"):
            provision_first_admin(username="first-admin", password="")
        with self.assertRaises(ValidationError):
            provision_first_admin(username="first-admin", password="password")

        self.assertEqual(User.objects.count(), 0)
        self.assertIsNone(InstallationState.objects.get().initialized_at)

    def test_duplicate_username_is_rejected_without_mutation(self):
        User.objects.create_user(username="existing-user", password="pass12345")

        with self.assertRaisesMessage(ValidationError, "用户名已存在"):
            provision_first_admin(username="existing-user", password="a-strong-bootstrap-pass")

        self.assertEqual(User.objects.count(), 1)
        self.assertIsNone(InstallationState.objects.get().initialized_at)

    def test_installation_state_direct_writes_require_account_authority(self):
        self.state.initialized_at = timezone.now()
        with self.assertRaisesMessage(ValidationError, "安装状态只能通过账户授权服务修改"):
            self.state.save()

        with self.assertRaisesMessage(ValidationError, "安装状态只能通过账户授权服务修改"):
            InstallationState.objects.filter(pk=self.state.pk).update(initialized_at=timezone.now())

        with self.assertRaisesMessage(ValidationError, "安装状态只能通过账户授权服务修改"):
            InstallationState.objects.bulk_update([self.state], ["initialized_at"])

        with self.assertRaisesMessage(ValidationError, "安装状态只能通过账户授权服务修改"):
            InstallationState.objects.bulk_create([InstallationState()])

        with self.assertRaisesMessage(ValidationError, "安装状态只能通过账户授权服务修改"):
            self.state.delete()

        self.assertIsNone(InstallationState.objects.get().initialized_at)


class ProvisionFirstAdminCommandTests(TestCase):
    @patch(
        "accounts.management.commands.provision_first_admin.sys.stdin",
        StringIO("a-strong-bootstrap-pass\n"),
    )
    def test_password_stdin_provisions_without_echoing_secret(self):
        output = StringIO()

        call_command(
            "provision_first_admin",
            "--username",
            "first-admin",
            "--password-stdin",
            stdout=output,
        )

        self.assertIn("Provisioned first ArtFlow administrator: first-admin", output.getvalue())
        self.assertNotIn("a-strong-bootstrap-pass", output.getvalue())
        self.assertTrue(
            User.objects.get(username="first-admin").check_password("a-strong-bootstrap-pass")
        )

    @patch.dict(os.environ, {}, clear=False)
    def test_command_requires_explicit_username(self):
        os.environ.pop("ARTFLOW_INITIAL_ADMIN_USERNAME", None)

        with self.assertRaisesMessage(CommandError, "A first administrator username is required"):
            call_command("provision_first_admin", "--password-stdin")


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
        real_admin = create_provisioned_user(
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
        revoker = create_provisioned_user(
            username="revoker", password="pass12345", role=User.Role.ADMIN
        )
        actor = create_provisioned_user(
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
        alone = create_provisioned_user(
            username="only-admin", password="pass12345", role=User.Role.ADMIN
        )
        set_user_active(target=self.super_admin, is_active=False, actor=alone)
        with self.assertRaises(ValidationError):
            change_user_role(target=alone, new_role=User.Role.PARTICIPANT, actor=alone)
        alone.refresh_from_db()
        self.assertEqual(alone.role, User.Role.ADMIN)

    def test_current_authority_rejects_stale_downgraded_and_disabled_actors(self):
        actor = create_provisioned_user(
            username="fresh-admin", password="pass12345", role=User.Role.ADMIN
        )
        stale_actor = User.objects.get(pk=actor.pk)
        self.assertEqual(require_current_admin(stale_actor).pk, actor.pk)

        change_user_role(target=actor, new_role=User.Role.STAFF, actor=self.super_admin)
        with self.assertRaises(PermissionDenied):
            require_current_admin(stale_actor)
        self.assertEqual(require_current_staff(stale_actor).pk, actor.pk)

        set_user_active(target=actor, is_active=False, actor=self.super_admin)
        with self.assertRaises(PermissionDenied):
            require_current_admin(stale_actor)
        with self.assertRaises(PermissionDenied):
            require_current_staff(stale_actor)


class AccountAuthorityBoundaryTests(TestCase):
    """Only audited account services may change security-bearing User fields."""

    def setUp(self):
        self.admin = create_provisioned_user(
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
        active_audit = AuditLog.objects.get(
            target=f"User:{self.target.pk}", old_value="active=True"
        )
        self.assertEqual(active_audit.new_value, "active=False")


class AccountAuthorityCreationTests(TestCase):
    """Initial account authority needs the same explicit scope as later changes."""

    def test_instance_save_rejects_nondefault_authority_values_on_creation(self):
        for suffix, values in (
            ("role", {"role": User.Role.ADMIN}),
            ("active", {"is_active": False}),
            ("superuser", {"is_superuser": True}),
        ):
            with self.subTest(field=suffix), self.assertRaises(ValidationError):
                User(username=f"instance-create-{suffix}", **values).save()

    def test_default_manager_create_rejects_nondefault_authority_values(self):
        for suffix, values in (
            ("role", {"role": User.Role.ADMIN}),
            ("active", {"is_active": False}),
            ("superuser", {"is_superuser": True}),
        ):
            with self.subTest(field=suffix), self.assertRaises(ValidationError):
                User.objects.create_user(username=f"manager-create-{suffix}", **values)

    def test_base_manager_create_rejects_nondefault_authority_values(self):
        for suffix, values in (
            ("role", {"role": User.Role.ADMIN}),
            ("active", {"is_active": False}),
            ("superuser", {"is_superuser": True}),
        ):
            with self.subTest(field=suffix), self.assertRaises(ValidationError):
                User._base_manager.create(username=f"base-create-{suffix}", **values)

    def test_bulk_create_rejects_nondefault_authority_values(self):
        for suffix, values in (
            ("role", {"role": User.Role.ADMIN}),
            ("active", {"is_active": False}),
            ("superuser", {"is_superuser": True}),
        ):
            with self.subTest(field=suffix), self.assertRaises(ValidationError):
                User.objects.bulk_create([User(username=f"bulk-create-{suffix}", **values)])

    def test_default_creation_remains_valid_and_authority_scope_allows_provisioning(self):
        ordinary = User.objects.create_user(username="ordinary-created", password="pass12345")
        self.assertEqual(ordinary.role, User.Role.PARTICIPANT)
        self.assertTrue(ordinary.is_active)
        self.assertFalse(ordinary.is_superuser)

        with authority_write(ACCOUNT_AUTHORITY):
            provisioned = User.objects.create_user(
                username="provisioned-created",
                password="pass12345",
                role=User.Role.ADMIN,
                is_superuser=True,
            )
        self.assertTrue(provisioned.is_admin)

    def test_conflict_profile_update_allows_existing_admin_authority_values(self):
        existing = create_provisioned_user(
            username="conflict-existing-admin",
            password="pass12345",
            role=User.Role.ADMIN,
        )
        existing.email = "updated@example.com"

        User.objects.bulk_create(
            [existing],
            update_conflicts=True,
            update_fields=["email"],
            unique_fields=["username"],
        )

        existing.refresh_from_db()
        self.assertEqual(existing.email, "updated@example.com")
        self.assertEqual(existing.role, User.Role.ADMIN)
        self.assertTrue(existing.is_staff)

    def test_conflict_update_rejects_protected_authority_field(self):
        existing = User.objects.create_user(
            username="conflict-existing-participant",
            password="pass12345",
        )

        with self.assertRaises(ValidationError):
            User.objects.bulk_create(
                [existing],
                update_conflicts=True,
                update_fields=["role"],
                unique_fields=["username"],
            )

    def test_authorized_conflict_role_update_derives_staff_flag(self):
        existing = User.objects.create_user(
            username="conflict-role-participant",
            password="pass12345",
        )
        replacement = User(
            username=existing.username,
            role=User.Role.STAFF,
        )

        with authority_write(ACCOUNT_AUTHORITY):
            User.objects.bulk_create(
                [replacement],
                update_conflicts=True,
                update_fields=["role"],
                unique_fields=["username"],
            )

        existing.refresh_from_db()
        self.assertEqual(existing.role, User.Role.STAFF)
        self.assertTrue(existing.is_staff)

    def test_positional_conflict_profile_update_allows_existing_admin_authority_values(self):
        existing = create_provisioned_user(
            username="positional-conflict-existing-admin",
            password="pass12345",
            role=User.Role.ADMIN,
        )
        existing.email = "positional-updated@example.com"

        User.objects.bulk_create(
            [existing],
            None,
            False,
            True,
            ["email"],
            ["username"],
        )

        existing.refresh_from_db()
        self.assertEqual(existing.email, "positional-updated@example.com")
        self.assertEqual(existing.role, User.Role.ADMIN)
        self.assertTrue(existing.is_staff)

    def test_positional_conflict_update_rejects_protected_authority_field(self):
        existing = User.objects.create_user(
            username="positional-conflict-existing-participant",
            password="pass12345",
        )

        with self.assertRaises(ValidationError):
            User.objects.bulk_create(
                [existing],
                None,
                False,
                True,
                ["role"],
                ["username"],
            )

    def test_positional_conflict_upsert_allows_existing_admin_and_ordinary_insert(self):
        existing = create_provisioned_user(
            username="positional-mixed-existing-admin",
            password="pass12345",
            role=User.Role.ADMIN,
        )
        existing.email = "mixed-updated@example.com"
        new_user = User(username="positional-mixed-new-participant", email="new@example.com")

        User.objects.bulk_create(
            [existing, new_user],
            None,
            False,
            True,
            ["email"],
            ["username"],
        )

        existing.refresh_from_db()
        self.assertEqual(existing.email, "mixed-updated@example.com")
        self.assertTrue(User.objects.filter(username=new_user.username).exists())

    def test_authorized_positional_conflict_role_update_derives_staff_flag(self):
        existing = User.objects.create_user(
            username="positional-conflict-role-participant",
            password="pass12345",
        )
        replacement = User(username=existing.username, role=User.Role.STAFF)

        with authority_write(ACCOUNT_AUTHORITY):
            User.objects.bulk_create(
                [replacement],
                None,
                False,
                True,
                ["role"],
                ["username"],
            )

        existing.refresh_from_db()
        self.assertEqual(existing.role, User.Role.STAFF)
        self.assertTrue(existing.is_staff)


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
        admin_a = create_provisioned_user(
            username="admin-a", password="pass12345", role=User.Role.ADMIN
        )
        admin_b = create_provisioned_user(
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
        admin_a = create_provisioned_user(
            username="deact-a", password="pass12345", role=User.Role.ADMIN
        )
        admin_b = create_provisioned_user(
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
