import importlib
import os
import subprocess
import sys
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from django.core.exceptions import ImproperlyConfigured
from django.test import SimpleTestCase, TestCase

DEVELOPMENT_SECRET_KEY = "django-insecure-dev-only-change-me"


def production_environment(**overrides):
    environment = {
        "APP_ENV": "production",
        "DEBUG": "False",
        "SECRET_KEY": "production-secret-key",
        "ADMIN_LOGIN_KEY": "production-admin-key",
        "ALLOWED_HOSTS": "artflow.internal",
        "CSRF_TRUSTED_ORIGINS": "https://artflow.internal",
        "DATABASE_ENGINE": "postgresql",
        "POSTGRES_DB": "artflow",
        "POSTGRES_USER": "artflow",
        "POSTGRES_PASSWORD": "production-database-password",
        "POSTGRES_HOST": "db.internal",
        "POSTGRES_PORT": "5432",
    }
    environment.update(overrides)
    return environment


class RuntimeTests(SimpleTestCase):
    def test_process_environment_takes_precedence_over_dotenv(self):
        from config.runtime import load_environment

        with TemporaryDirectory() as directory:
            Path(directory, ".env").write_text("ARTFLOW_TEST_VALUE=from-dotenv\n")
            with patch.dict(os.environ, {"ARTFLOW_TEST_VALUE": "from-process"}, clear=False):
                load_environment(Path(directory))

                self.assertEqual(os.environ["ARTFLOW_TEST_VALUE"], "from-process")

    def test_unknown_app_env_is_rejected(self):
        from config.runtime import get_app_env

        with patch.dict(os.environ, {"APP_ENV": "staging"}, clear=False):
            with self.assertRaises(ImproperlyConfigured):
                get_app_env()

    def test_production_rejects_development_secret_key_without_leaking_it(self):
        from config.runtime import validate_production_environment

        with self.assertRaises(ImproperlyConfigured) as error:
            validate_production_environment(
                production_environment(SECRET_KEY=DEVELOPMENT_SECRET_KEY)
            )

        self.assertNotIn(DEVELOPMENT_SECRET_KEY, str(error.exception))

    def test_production_rejects_empty_admin_login_key(self):
        from config.runtime import validate_production_environment

        with self.assertRaises(ImproperlyConfigured):
            validate_production_environment(production_environment(ADMIN_LOGIN_KEY=""))

    def test_production_rejects_missing_allowed_hosts(self):
        from config.runtime import validate_production_environment

        with self.assertRaises(ImproperlyConfigured):
            validate_production_environment(production_environment(ALLOWED_HOSTS=""))

    def test_production_rejects_missing_csrf_trusted_origins(self):
        from config.runtime import validate_production_environment

        with self.assertRaises(ImproperlyConfigured):
            validate_production_environment(production_environment(CSRF_TRUSTED_ORIGINS=""))

    def test_production_rejects_sqlite(self):
        from config.runtime import validate_production_environment

        with self.assertRaises(ImproperlyConfigured):
            validate_production_environment(production_environment(DATABASE_ENGINE="sqlite"))

    def test_production_rejects_template_placeholders_without_leaking_values(self):
        from config.runtime import validate_production_environment

        placeholders = {
            "SECRET_KEY": "set-a-long-random-production-secret",
            "ADMIN_LOGIN_KEY": "set-a-long-random-admin-login-key",
            "ALLOWED_HOSTS": "artflow.example.com",
            "CSRF_TRUSTED_ORIGINS": "https://artflow.example.com",
            "POSTGRES_PASSWORD": "set-a-strong-database-password",
            "POSTGRES_HOST": "db.example.com",
        }
        for name, placeholder in placeholders.items():
            with self.subTest(name=name):
                with self.assertRaises(ImproperlyConfigured) as error:
                    validate_production_environment(production_environment(**{name: placeholder}))

                self.assertNotIn(placeholder, str(error.exception))

    def test_production_accepts_generic_non_placeholder_values(self):
        from config.runtime import validate_production_environment

        validate_production_environment(production_environment())

    def test_production_accepts_hosts_that_only_end_with_example_domain_characters(self):
        from config.runtime import validate_production_environment

        validate_production_environment(
            production_environment(
                ALLOWED_HOSTS="notexample.com",
                CSRF_TRUSTED_ORIGINS="https://notexample.com",
                POSTGRES_HOST="db.notexample.com",
            )
        )


class HealthEndpointTests(TestCase):
    def test_healthz_returns_only_a_generic_success_response_to_anonymous_get(self):
        response = self.client.get("/healthz/")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"status": "ok"})

    def test_healthz_rejects_non_get_requests(self):
        response = self.client.post("/healthz/")

        self.assertEqual(response.status_code, 405)


class SettingsTests(SimpleTestCase):
    def reload_settings(self, environment):
        with (
            patch.dict(os.environ, environment, clear=True),
            patch("config.runtime.load_environment"),
        ):
            settings_module = importlib.import_module("config.settings")
            return importlib.reload(settings_module)

    def test_development_defaults_to_sqlite(self):
        settings_module = self.reload_settings({"APP_ENV": "development"})

        self.assertEqual(
            settings_module.DATABASES["default"]["ENGINE"], "django.db.backends.sqlite3"
        )

    def test_test_environment_defaults_to_sqlite(self):
        settings_module = self.reload_settings({"APP_ENV": "test"})

        self.assertEqual(
            settings_module.DATABASES["default"]["ENGINE"], "django.db.backends.sqlite3"
        )

    def test_development_rejects_malformed_debug_value(self):
        with self.assertRaises(ImproperlyConfigured):
            self.reload_settings({"APP_ENV": "development", "DEBUG": "not-a-boolean"})

    def test_test_environment_rejects_unknown_database_engine(self):
        with self.assertRaises(ImproperlyConfigured):
            self.reload_settings({"APP_ENV": "test", "DATABASE_ENGINE": "not-a-database"})

    def test_static_directory_exists_for_staticfiles_validation(self):
        from django.conf import settings

        self.assertTrue(Path(settings.STATICFILES_DIRS[0]).is_dir())

    def test_production_enables_secure_transport_and_cookie_settings(self):
        settings_module = self.reload_settings(production_environment())

        self.assertFalse(settings_module.DEBUG)
        self.assertTrue(settings_module.SECURE_SSL_REDIRECT)
        self.assertEqual(
            settings_module.SECURE_PROXY_SSL_HEADER, ("HTTP_X_FORWARDED_PROTO", "https")
        )
        self.assertTrue(settings_module.SESSION_COOKIE_SECURE)
        self.assertTrue(settings_module.CSRF_COOKIE_SECURE)
        self.assertGreater(settings_module.SECURE_HSTS_SECONDS, 0)
        self.assertTrue(settings_module.SECURE_HSTS_INCLUDE_SUBDOMAINS)
        self.assertTrue(settings_module.SECURE_HSTS_PRELOAD)

    def test_production_check_reports_invalid_configuration_without_secret_values(self):
        from config.checks import production_config_check

        environment = production_environment(DATABASE_ENGINE="sqlite")
        with patch.dict(os.environ, environment, clear=True):
            errors = production_config_check()

        self.assertEqual([error.id for error in errors], ["config.E001"])
        self.assertNotIn(environment["SECRET_KEY"], errors[0].msg)
        self.assertNotIn(environment["SECRET_KEY"], errors[0].hint)

    def run_production_check(self, **overrides):
        environment = os.environ.copy()
        environment.update(production_environment(**overrides))

        return environment, subprocess.run(
            [sys.executable, "manage.py", "check"],
            cwd=Path(__file__).resolve().parent.parent,
            env=environment,
            capture_output=True,
            check=False,
            text=True,
        )

    def assert_production_check_reports_config_error(self, environment, result):
        output = result.stdout + result.stderr
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("config.E001", output)
        self.assertNotIn(environment["SECRET_KEY"], output)
        self.assertNotIn(environment["POSTGRES_PASSWORD"], output)

    def test_manage_check_reports_invalid_production_configuration_as_config_error(self):
        environment, result = self.run_production_check(DATABASE_ENGINE="sqlite")

        self.assert_production_check_reports_config_error(environment, result)

    def test_manage_check_reports_malformed_production_debug_as_config_error(self):
        environment, result = self.run_production_check(DEBUG="not-a-boolean")

        self.assert_production_check_reports_config_error(environment, result)

    def test_manage_check_reports_unknown_production_database_engine_as_config_error(self):
        environment, result = self.run_production_check(DATABASE_ENGINE="not-a-database")

        self.assert_production_check_reports_config_error(environment, result)

    def test_doctor_reports_invalid_production_configuration_without_secret_values(self):
        environment, result = self.run_production_doctor(DATABASE_ENGINE="sqlite")

        output = result.stdout + result.stderr
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Environment: production", output)
        self.assertIn("Configuration: failed", output)
        self.assertNotIn(environment["SECRET_KEY"], output)
        self.assertNotIn(environment["ADMIN_LOGIN_KEY"], output)
        self.assertNotIn(environment["POSTGRES_PASSWORD"], output)

    def run_production_doctor(self, **overrides):
        environment = os.environ.copy()
        environment.update(production_environment(**overrides))

        return environment, subprocess.run(
            [sys.executable, "manage.py", "doctor"],
            cwd=Path(__file__).resolve().parent.parent,
            env=environment,
            capture_output=True,
            check=False,
            text=True,
        )
