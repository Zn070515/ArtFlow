import os
from pathlib import Path
from typing import Literal, Mapping

from django.core.exceptions import ImproperlyConfigured
from dotenv import load_dotenv

DEVELOPMENT_SECRET_KEY = "django-insecure-dev-only-change-me"
AppEnvironment = Literal["development", "test", "production"]


def load_environment(base_dir: Path) -> None:
    load_dotenv(base_dir / ".env", override=False)


def get_app_env() -> AppEnvironment:
    app_env = os.environ.get("APP_ENV", "development").strip().lower()
    if app_env == "development":
        return "development"
    if app_env == "test":
        return "test"
    if app_env == "production":
        return "production"
    raise ImproperlyConfigured("APP_ENV must be development, test, or production.")


def get_bool(env: Mapping[str, str], name: str, default: bool) -> bool:
    value = env.get(name)
    if value is None or not value.strip():
        return default
    normalized_value = value.strip().lower()
    if normalized_value in {"1", "true", "yes", "on"}:
        return True
    if normalized_value in {"0", "false", "no", "off"}:
        return False
    raise ImproperlyConfigured(f"{name} must be a boolean value.")


def get_csv(env: Mapping[str, str], name: str, default: str = "") -> list[str]:
    value = env.get(name, default)
    return [item.strip() for item in value.split(",") if item.strip()]


def validate_production_environment(env: Mapping[str, str]) -> None:
    secret_key = env.get("SECRET_KEY", "").strip()
    if not secret_key:
        raise ImproperlyConfigured("Production configuration requires SECRET_KEY.")
    if secret_key == DEVELOPMENT_SECRET_KEY:
        raise ImproperlyConfigured("Production SECRET_KEY cannot use the development default.")
    if not env.get("ADMIN_LOGIN_KEY", "").strip():
        raise ImproperlyConfigured("Production configuration requires ADMIN_LOGIN_KEY.")
    if get_bool(env, "DEBUG", default=False):
        raise ImproperlyConfigured("Production configuration requires DEBUG to be disabled.")
    if not get_csv(env, "ALLOWED_HOSTS"):
        raise ImproperlyConfigured("Production configuration requires ALLOWED_HOSTS.")
    if not get_csv(env, "CSRF_TRUSTED_ORIGINS"):
        raise ImproperlyConfigured("Production configuration requires CSRF_TRUSTED_ORIGINS.")
    if env.get("DATABASE_ENGINE", "sqlite").strip().lower() != "postgresql":
        raise ImproperlyConfigured("Production configuration requires DATABASE_ENGINE=postgresql.")

    missing_database_values = [
        name
        for name in ("POSTGRES_DB", "POSTGRES_USER", "POSTGRES_PASSWORD", "POSTGRES_HOST")
        if not env.get(name, "").strip()
    ]
    if missing_database_values:
        raise ImproperlyConfigured(
            "Production configuration requires " + ", ".join(missing_database_values) + "."
        )
