import importlib
import os
import subprocess
import sys
from contextlib import contextmanager
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from django.core.exceptions import ImproperlyConfigured
from django.db import DatabaseError, connections
from django.test import Client, RequestFactory, SimpleTestCase, TestCase, override_settings

from config import health as health_module

DEVELOPMENT_SECRET_KEY = "django-insecure-dev-only-change-me"


def production_environment(**overrides):
    environment = {
        "APP_ENV": "production",
        "DEBUG": "False",
        "SECRET_KEY": "production-secret-key",
        "QR_SIGNING_KEY": "production-qr-signing-key",
        "STAFF_ACCESS_KEY": "production-staff-key",
        "ADMIN_ACCESS_KEY": "production-admin-key",
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

    def test_production_rejects_empty_staff_access_key(self):
        from config.runtime import validate_production_environment

        with self.assertRaises(ImproperlyConfigured):
            validate_production_environment(production_environment(STAFF_ACCESS_KEY=""))

    def test_production_rejects_empty_admin_access_key(self):
        from config.runtime import validate_production_environment

        with self.assertRaises(ImproperlyConfigured):
            validate_production_environment(production_environment(ADMIN_ACCESS_KEY=""))

    def test_production_does_not_accept_legacy_admin_login_key_as_a_substitute(self):
        from config.runtime import validate_production_environment

        environment = production_environment(ADMIN_LOGIN_KEY="legacy-admin-key")
        environment.pop("STAFF_ACCESS_KEY")
        environment.pop("ADMIN_ACCESS_KEY")
        with self.assertRaises(ImproperlyConfigured):
            validate_production_environment(environment)

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
            "QR_SIGNING_KEY": "set-a-long-random-qr-signing-key",
            "STAFF_ACCESS_KEY": "set-a-long-random-staff-access-key",
            "ADMIN_ACCESS_KEY": "set-a-long-random-admin-access-key",
            "ARTFLOW_RELEASE_SHA": "replace-me-with-the-deployed-commit-sha",
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


class BrandingContextTests(SimpleTestCase):
    def test_branding_context_exposes_optional_organization_name(self):
        from config.context_processors import artflow_branding

        request = RequestFactory().get("/")
        with override_settings(ARTFLOW_ORGANIZATION_NAME=""):
            self.assertEqual(artflow_branding(request)["artflow_organization_name"], "")
        with override_settings(ARTFLOW_ORGANIZATION_NAME="示例主办方"):
            self.assertEqual(
                artflow_branding(request)["artflow_organization_name"],
                "示例主办方",
            )

    def test_branding_context_exposes_optional_icp_metadata(self):
        from config.context_processors import artflow_branding

        request = RequestFactory().get("/")
        with override_settings(
            ARTFLOW_ICP_NUMBER="浙ICP备00000000号", ARTFLOW_ICP_URL="https://beian.example"
        ):
            branding = artflow_branding(request)

        self.assertEqual(branding["artflow_icp_number"], "浙ICP备00000000号")
        self.assertEqual(branding["artflow_icp_url"], "https://beian.example")


class HealthEndpointTests(TestCase):
    def test_healthz_returns_only_a_generic_success_response_to_anonymous_get(self):
        response = self.client.get("/healthz/")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"status": "ok"})

    def test_healthz_rejects_non_get_requests(self):
        response = self.client.post("/healthz/")

        self.assertEqual(response.status_code, 405)
        self.assertEqual(response.json(), {"status": "unavailable"})
        self.assertEqual(response["Allow"], "GET")

    def test_healthz_non_get_contract_survives_csrf_middleware(self):
        csrf_client = Client(enforce_csrf_checks=True)

        response = csrf_client.post("/healthz/")

        self.assertEqual(response.status_code, 405)
        self.assertEqual(response.json(), {"status": "unavailable"})
        self.assertEqual(response["Allow"], "GET")

    def test_healthz_returns_generic_unavailable_response_for_database_errors(self):
        with patch.object(
            connections["default"],
            "ensure_connection",
            side_effect=DatabaseError("database-secret"),
        ):
            response = self.client.get("/healthz/")

        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json(), {"status": "unavailable"})
        self.assertNotIn("database-secret", response.content.decode())

    def test_livez_reports_liveness_even_when_the_database_is_unreachable(self):
        with patch.object(
            connections["default"],
            "ensure_connection",
            side_effect=DatabaseError("database-secret"),
        ):
            response = self.client.get("/livez/")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"status": "alive"})
        self.assertNotIn("database-secret", response.content.decode())

    def test_livez_rejects_non_get_requests(self):
        response = self.client.post("/livez/")

        self.assertEqual(response.status_code, 405)
        self.assertEqual(response.json(), {"status": "unavailable"})
        self.assertEqual(response["Allow"], "GET")

    def test_readyz_reports_a_reachable_database(self):
        response = self.client.get("/readyz/")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"status": "ok"})

    def test_readyz_is_unavailable_when_the_database_is_unreachable(self):
        with patch.object(
            connections["default"],
            "ensure_connection",
            side_effect=DatabaseError("database-secret"),
        ):
            response = self.client.get("/readyz/")

        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json(), {"status": "unavailable"})
        self.assertNotIn("database-secret", response.content.decode())

    def test_readyz_is_unavailable_when_a_database_query_fails(self):
        with patch.object(connections["default"], "cursor") as cursor_factory:
            cursor = cursor_factory.return_value.__enter__.return_value
            cursor.execute.side_effect = DatabaseError("database-secret")

            response = self.client.get("/readyz/")

        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json(), {"status": "unavailable"})
        cursor.execute.assert_called_once_with("SELECT 1")
        self.assertNotIn("database-secret", response.content.decode())

    def test_readyz_rejects_non_get_requests(self):
        response = self.client.post("/readyz/")

        self.assertEqual(response.status_code, 405)
        self.assertEqual(response.json(), {"status": "unavailable"})
        self.assertEqual(response["Allow"], "GET")

    def test_probes_never_run_the_full_system_check_set(self):
        # run_checks() belongs to startup, doctor and the deployment gate. The
        # probes are polled every 10-15 s, so the set must not be reachable from
        # any of them; create=True keeps the assertion honest if the import ever
        # comes back.
        with patch.object(
            health_module,
            "run_checks",
            create=True,
            side_effect=AssertionError("system checks belong to startup"),
        ):
            responses = [
                self.client.get("/livez/"),
                self.client.get("/readyz/"),
                self.client.get("/healthz/"),
            ]

        self.assertEqual([response.status_code for response in responses], [200, 200, 200])


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

    def test_production_postgresql_reuses_connections_with_health_checks(self):
        settings_module = self.reload_settings(production_environment())
        default = settings_module.DATABASES["default"]

        self.assertEqual(default["ENGINE"], "django.db.backends.postgresql")
        self.assertEqual(default["CONN_MAX_AGE"], 60)
        self.assertTrue(default["CONN_HEALTH_CHECKS"])

    def test_postgresql_connection_reuse_is_configurable(self):
        settings_module = self.reload_settings(
            {**production_environment(), "POSTGRES_CONN_MAX_AGE": "0"}
        )

        self.assertEqual(settings_module.DATABASES["default"]["CONN_MAX_AGE"], 0)

    def test_sqlite_keeps_the_django_default_connection_lifecycle(self):
        default = self.reload_settings({"APP_ENV": "development"}).DATABASES["default"]

        self.assertNotIn("CONN_MAX_AGE", default)
        self.assertNotIn("CONN_HEALTH_CHECKS", default)

    def test_rate_limit_backend_is_locmem_outside_production_and_database_in_production(self):
        development_backend = self.reload_settings({"APP_ENV": "development"}).RATE_LIMIT_BACKEND
        test_backend = self.reload_settings({"APP_ENV": "test"}).RATE_LIMIT_BACKEND
        production_backend = self.reload_settings(production_environment()).RATE_LIMIT_BACKEND
        event_backend = self.reload_settings(
            {"APP_ENV": "development", "RATE_LIMIT_BACKEND": "database"}
        ).RATE_LIMIT_BACKEND

        self.assertEqual(development_backend, "locmem")
        self.assertEqual(test_backend, "locmem")
        self.assertEqual(production_backend, "database")
        self.assertEqual(event_backend, "database")

    def test_unknown_rate_limit_backend_is_rejected(self):
        with self.assertRaises(ImproperlyConfigured):
            self.reload_settings({"APP_ENV": "development", "RATE_LIMIT_BACKEND": "per-worker"})

    def test_development_rejects_malformed_debug_value(self):
        with self.assertRaises(ImproperlyConfigured):
            self.reload_settings({"APP_ENV": "development", "DEBUG": "not-a-boolean"})

    def test_test_environment_rejects_unknown_database_engine(self):
        with self.assertRaises(ImproperlyConfigured):
            self.reload_settings({"APP_ENV": "test", "DATABASE_ENGINE": "not-a-database"})

    def test_delivery_backend_defaults_to_local(self):
        settings_module = self.reload_settings(production_environment())

        self.assertEqual(settings_module.ARTFLOW_DELIVERY_BACKEND, "local")

    def test_delivery_backend_rejects_an_unimplemented_name(self):
        with self.assertRaises(ImproperlyConfigured):
            self.reload_settings({"APP_ENV": "development", "ARTFLOW_DELIVERY_BACKEND": "oss"})

    def test_static_directory_exists_for_staticfiles_validation(self):
        from django.conf import settings

        self.assertTrue(Path(settings.STATICFILES_DIRS[0]).is_dir())

    def test_non_debug_runtime_uses_whitenoise_static_storage(self):
        development_backend = self.reload_settings(
            {"APP_ENV": "development", "DEBUG": "False"}
        ).STORAGES["staticfiles"]["BACKEND"]
        production_backend = self.reload_settings(production_environment()).STORAGES["staticfiles"][
            "BACKEND"
        ]

        self.assertEqual(
            development_backend, "whitenoise.storage.CompressedManifestStaticFilesStorage"
        )
        self.assertEqual(production_backend, development_backend)

    def test_production_enables_secure_transport_and_cookie_settings(self):
        settings_module = self.reload_settings(production_environment())

        self.assertFalse(settings_module.DEBUG)
        self.assertTrue(settings_module.SECURE_SSL_REDIRECT)
        self.assertEqual(
            settings_module.SECURE_REDIRECT_EXEMPT,
            [r"^livez/$", r"^readyz/$", r"^healthz/$"],
        )
        self.assertEqual(
            settings_module.SECURE_PROXY_SSL_HEADER, ("HTTP_X_FORWARDED_PROTO", "https")
        )
        self.assertTrue(settings_module.SESSION_COOKIE_SECURE)
        self.assertTrue(settings_module.CSRF_COOKIE_SECURE)
        self.assertEqual(settings_module.SECURE_HSTS_SECONDS, 300)
        self.assertFalse(settings_module.SECURE_HSTS_INCLUDE_SUBDOMAINS)
        self.assertFalse(settings_module.SECURE_HSTS_PRELOAD)

    def test_https_redirect_exempts_every_probe_route_but_not_public_pages(self):
        with (
            override_settings(
                SECURE_SSL_REDIRECT=True,
                SECURE_REDIRECT_EXEMPT=[r"^livez/$", r"^readyz/$", r"^healthz/$"],
            ),
            patch.object(connections["default"], "cursor"),
        ):
            probe_responses = [
                self.client.get("/livez/"),
                self.client.get("/readyz/"),
                self.client.get("/healthz/"),
            ]
            public_response = self.client.get("/")

        self.assertEqual([response.status_code for response in probe_responses], [200, 200, 200])
        self.assertEqual(public_response.status_code, 301)
        self.assertTrue(public_response["Location"].startswith("https://"))

    def test_production_check_reports_invalid_configuration_without_secret_values(self):
        from config.checks import production_config_check

        environment = production_environment(DATABASE_ENGINE="sqlite")
        with patch.dict(os.environ, environment, clear=True):
            errors = production_config_check()

        self.assertEqual([error.id for error in errors], ["config.E001"])
        self.assertNotIn(environment["SECRET_KEY"], errors[0].msg)
        assert errors[0].hint is not None
        self.assertNotIn(environment["SECRET_KEY"], errors[0].hint)

    def isolated_production_environment(self, **overrides):
        environment = os.environ.copy()
        for name in (
            "APP_ENV",
            "DEBUG",
            "SECRET_KEY",
            "QR_SIGNING_KEY",
            "STAFF_ACCESS_KEY",
            "ADMIN_ACCESS_KEY",
            "ALLOWED_HOSTS",
            "CSRF_TRUSTED_ORIGINS",
            "DATABASE_ENGINE",
            "POSTGRES_DB",
            "POSTGRES_USER",
            "POSTGRES_PASSWORD",
            "POSTGRES_HOST",
            "POSTGRES_PORT",
        ):
            environment.pop(name, None)
        environment["APP_ENV"] = "production"
        environment["PYTHON_DOTENV_DISABLED"] = "1"
        environment.update(overrides)
        return environment

    @contextmanager
    def temporary_repository_dotenv(self):
        dotenv_path = Path(__file__).resolve().parent.parent / ".env"
        dotenv_contents = (
            "\n".join(f"{name}={value}" for name, value in production_environment().items()) + "\n"
        )

        if dotenv_path.exists():
            yield dotenv_path
            return

        dotenv_path.write_text(dotenv_contents, encoding="utf-8")
        try:
            yield dotenv_path
        finally:
            if dotenv_path.exists() and dotenv_path.read_text(encoding="utf-8") == dotenv_contents:
                dotenv_path.unlink()

    def run_production_startup(self, command, **overrides):
        environment = self.isolated_production_environment(**overrides)
        return environment, subprocess.run(
            command,
            cwd=Path(__file__).resolve().parent.parent,
            env=environment,
            capture_output=True,
            check=False,
            text=True,
        )

    def assert_incomplete_production_startup_is_rejected(self, environment, result):
        output = result.stdout + result.stderr
        self.assertEqual(environment["PYTHON_DOTENV_DISABLED"], "1")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Production configuration requires SECRET_KEY.", output)
        self.assertNotIn(DEVELOPMENT_SECRET_KEY, output)
        self.assertNotIn("django.db.backends.sqlite3", output)

    def test_incomplete_production_environment_blocks_all_startup_entry_points(self):
        commands = {
            "django_setup": [
                sys.executable,
                "-c",
                (
                    "import os; "
                    "os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings'); "
                    "import django; django.setup()"
                ),
            ],
            "wsgi": [sys.executable, "-c", "import config.wsgi"],
            "asgi": [sys.executable, "-c", "import config.asgi"],
            "check": [sys.executable, "manage.py", "check"],
            "doctor": [sys.executable, "manage.py", "doctor"],
        }

        with self.temporary_repository_dotenv() as dotenv_path:
            self.assertTrue(dotenv_path.is_file())
            for startup_path, command in commands.items():
                with self.subTest(startup_path=startup_path):
                    environment, result = self.run_production_startup(command)

                    self.assert_incomplete_production_startup_is_rejected(environment, result)

    def test_production_does_not_route_django_admin(self):
        from django.urls import clear_url_caches

        import config.urls

        with override_settings(APP_ENV="production"):
            importlib.reload(config.urls)
            clear_url_caches()
            response = self.client.get("/admin/login/")
        self.assertEqual(response.status_code, 404)

        importlib.reload(config.urls)
        clear_url_caches()

    def test_valid_production_environment_allows_django_setup_with_postgresql(self):
        environment, result = self.run_production_startup(
            [
                sys.executable,
                "-c",
                (
                    "import os; "
                    "os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings'); "
                    "import django; django.setup(); "
                    "from django.conf import settings; "
                    "print(settings.DATABASES['default']['ENGINE'])"
                ),
            ],
            **production_environment(),
        )

        output = result.stdout + result.stderr
        self.assertEqual(result.returncode, 0, output)
        self.assertIn("django.db.backends.postgresql", output)
