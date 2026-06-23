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
        response = self.client.post(reverse("accounts:login"), {
            "login_mode": "normal",
            "username": "participant",
            "password": "pass12345",
        })
        self.assertEqual(response.status_code, 302)
        self.assertEqual(response.url, reverse("public_portal:home"))

    def test_normal_login_rejects_admin_user(self):
        response = self.client.post(reverse("accounts:login"), {
            "login_mode": "normal",
            "username": "admin",
            "password": "pass12345",
        })
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "管理员账号请使用管理员登录入口。")

    @override_settings(ADMIN_LOGIN_KEY="secret-key")
    def test_admin_login_requires_correct_key(self):
        response = self.client.post(reverse("accounts:admin_login"), {
            "username": "admin",
            "password": "pass12345",
            "admin_key": "wrong-key",
        })
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "管理员密钥错误。")

    @override_settings(ADMIN_LOGIN_KEY="secret-key")
    def test_admin_login_redirects_admin_to_staff_dashboard(self):
        response = self.client.post(reverse("accounts:admin_login"), {
            "username": "admin",
            "password": "pass12345",
            "admin_key": "secret-key",
        })
        self.assertEqual(response.status_code, 302)
        self.assertEqual(response.url, reverse("staff:dashboard"))

    @override_settings(ADMIN_LOGIN_KEY="secret-key")
    def test_admin_login_rejects_non_admin_user(self):
        response = self.client.post(reverse("accounts:admin_login"), {
            "username": "participant",
            "password": "pass12345",
            "admin_key": "secret-key",
        })
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "该账号不是管理员账号。")

    def test_normal_login_page_links_to_admin_login(self):
        response = self.client.get(reverse("accounts:login"))
        self.assertContains(response, reverse("accounts:admin_login"))
        self.assertContains(response, "管理员登录")
