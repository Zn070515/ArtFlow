import importlib
import os
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from django.core.exceptions import ImproperlyConfigured
from django.test import SimpleTestCase

DEVELOPMENT_SECRET_KEY = "django-insecure-dev-only-change-me"


def production_environment(**overrides):
    environment = {
        "APP_ENV": "production",
        "DEBUG": "False",
        "SECRET_KEY": "production-secret-key",
        "ADMIN_LOGIN_KEY": "production-admin-key",
        "ALLOWED_HOSTS": "artflow.example.com",
        "CSRF_TRUSTED_ORIGINS": "https://artflow.example.com",
        "DATABASE_ENGINE": "postgresql",
        "POSTGRES_DB": "artflow",
        "POSTGRES_USER": "artflow",
        "POSTGRES_PASSWORD": "production-database-password",
        "POSTGRES_HOST": "db.example.com",
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
