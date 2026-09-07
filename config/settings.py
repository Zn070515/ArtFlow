import os
from pathlib import Path

from django.core.exceptions import ImproperlyConfigured

from config.runtime import (
    DEVELOPMENT_SECRET_KEY,
    get_app_env,
    get_bool,
    get_csv,
    get_int,
    load_environment,
    validate_production_environment,
)

BASE_DIR = Path(__file__).resolve().parent.parent

load_environment(BASE_DIR)
APP_ENV = get_app_env()
if APP_ENV == "production":
    validate_production_environment(os.environ)

SECRET_KEY = os.environ.get("SECRET_KEY", DEVELOPMENT_SECRET_KEY)
ADMIN_LOGIN_KEY = os.environ.get("ADMIN_LOGIN_KEY", "")

DEBUG = get_bool(os.environ, "DEBUG", default=APP_ENV == "development")

# Production workers must share throttle buckets through the primary database.
# Development and tests deliberately default to lightweight local cache behavior,
# while the local event manifest may explicitly opt into the shared database store.
RATE_LIMIT_BACKEND = (
    os.environ.get("RATE_LIMIT_BACKEND", "database" if APP_ENV == "production" else "locmem")
    .strip()
    .lower()
)
if RATE_LIMIT_BACKEND not in {"database", "locmem"}:
    raise ImproperlyConfigured("RATE_LIMIT_BACKEND must be locmem or database.")
if APP_ENV == "production" and RATE_LIMIT_BACKEND != "database":
    raise ImproperlyConfigured("Production configuration requires RATE_LIMIT_BACKEND=database.")

ALLOWED_HOSTS = get_csv(os.environ, "ALLOWED_HOSTS", "localhost,127.0.0.1,testserver")
CSRF_TRUSTED_ORIGINS = get_csv(os.environ, "CSRF_TRUSTED_ORIGINS")
# Only trust X-Forwarded-For when a known reverse proxy overwrites and appends
# to it. Default False so clients that share the app directly cannot spoof the
# audit/source IP; they must present REMOTE_ADDR as seen by Gunicorn.
TRUST_X_FORWARDED_FOR = get_bool(os.environ, "TRUST_X_FORWARDED_FOR", default=False)

INSTALLED_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    # ArtFlow
    "entry_access",
    "accounts",
    "core",
    "common",
    "public_portal",
    "files",
    "ruleset",
    "singer_contest",
    "farewell_show",
    "voting",
    "exports",
    "archive",
    "incidents",
    "staff_panel",
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "whitenoise.middleware.WhiteNoiseMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

ROOT_URLCONF = "config.urls"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [BASE_DIR / "templates"],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ],
        },
    },
]

WSGI_APPLICATION = "config.wsgi.application"

DATABASE_ENGINE = os.environ.get("DATABASE_ENGINE", "sqlite").strip().lower()
if DATABASE_ENGINE == "postgresql":
    DATABASES = {
        "default": {
            "ENGINE": "django.db.backends.postgresql",
            "NAME": os.environ.get("POSTGRES_DB", "artflow"),
            "USER": os.environ.get("POSTGRES_USER", "artflow"),
            "PASSWORD": os.environ.get("POSTGRES_PASSWORD", ""),
            "HOST": os.environ.get("POSTGRES_HOST", "localhost"),
            "PORT": os.environ.get("POSTGRES_PORT", "5432"),
        }
    }
elif DATABASE_ENGINE == "sqlite":
    DATABASES = {
        "default": {
            "ENGINE": "django.db.backends.sqlite3",
            "NAME": str(BASE_DIR / "db.sqlite3"),
        }
    }
else:
    raise ImproperlyConfigured("DATABASE_ENGINE must be sqlite or postgresql.")

AUTH_USER_MODEL = "accounts.User"

LOGIN_URL = "/login/"
LOGIN_REDIRECT_URL = "/"
LOGOUT_REDIRECT_URL = "/"

AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator"},
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
]

LANGUAGE_CODE = "zh-hans"
TIME_ZONE = "Asia/Shanghai"
USE_I18N = True
USE_TZ = True

STATIC_URL = "static/"
STATICFILES_DIRS = [BASE_DIR / "static"]
STATIC_ROOT = BASE_DIR / "staticfiles"

# The production and event containers run with DEBUG=False and have no separate
# static server. WhiteNoise serves the collected, hashed bundle from the same
# Gunicorn process; local DEBUG runs keep Django's normal static finder behavior.
STORAGES = {
    "default": {"BACKEND": "django.core.files.storage.FileSystemStorage"},
    "staticfiles": {
        "BACKEND": (
            "whitenoise.storage.CompressedManifestStaticFilesStorage"
            if not DEBUG
            else "django.contrib.staticfiles.storage.StaticFilesStorage"
        )
    },
}

MEDIA_URL = "media/"
MEDIA_ROOT = BASE_DIR / "media"

FILE_UPLOAD_MAX_MEMORY_SIZE = 20 * 1024 * 1024  # 20 MB
DATA_UPLOAD_MAX_MEMORY_SIZE = 20 * 1024 * 1024  # 20 MB

# Formalities that don't need a performer-sourced video on the first round.
# Above this many MiB, a PERFORMANCE_VIDEO / BACKGROUND_VIDEO direct upload is
# rejected for a FORMAL activity (test-mode activities keep the larger dev cap).
ARTFLOW_VIDEO_UPLOAD_MAX_MB = get_int(os.environ, "ARTFLOW_VIDEO_UPLOAD_MAX_MB", 100)

# How long (seconds) an admin's elevated second-factor verification stays valid.
# After this window the admin must re-enter ADMIN_LOGIN_KEY on sensitive actions.
ADMIN_VERIFICATION_TTL_SECONDS = get_int(os.environ, "ADMIN_VERIFICATION_TTL_SECONDS", 15 * 60)

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

SECURE_SSL_REDIRECT = APP_ENV == "production"
SECURE_REDIRECT_EXEMPT = [r"^healthz/$"]
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https") if APP_ENV == "production" else None
SESSION_COOKIE_SECURE = APP_ENV == "production"
SESSION_COOKIE_HTTPONLY = True
SESSION_COOKIE_SAMESITE = "Lax"
CSRF_COOKIE_SECURE = APP_ENV == "production"
CSRF_COOKIE_HTTPONLY = True
CSRF_COOKIE_SAMESITE = "Lax"
SECURE_HSTS_SECONDS = 31_536_000 if APP_ENV == "production" else 0
SECURE_HSTS_INCLUDE_SUBDOMAINS = APP_ENV == "production"
SECURE_HSTS_PRELOAD = APP_ENV == "production"
SECURE_REFERRER_POLICY = "same-origin"

# Register system checks only after the runtime environment has been loaded.
import config.checks  # noqa: E402, F401
