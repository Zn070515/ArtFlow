import os
from io import StringIO
from unittest.mock import patch

from django.core.management import call_command
from django.core.management.base import CommandError
from django.test import TestCase, override_settings
from django.urls import reverse

from .models import User


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

    def test_normal_login_page_links_to_admin_login(self):
        response = self.client.get(reverse("accounts:login"))
        self.assertContains(response, reverse("accounts:admin_login"))
        self.assertContains(response, "管理员登录")


class UserPermissionSynchronizationTests(TestCase):
    def test_demoting_staff_user_clears_django_staff_flag(self):
        user = User.objects.create_user(
            username="demoted-staff",
            password="pass12345",
            role=User.Role.STAFF,
        )
        self.assertTrue(user.is_staff)

        user.role = User.Role.PARTICIPANT
        user.save()

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
