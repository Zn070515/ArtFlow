import subprocess
import sys
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
HOSTNAME_VALIDATOR = REPOSITORY_ROOT / "scripts" / "validate_production_hostname.py"
POSIX_SCRIPTS = (
    REPOSITORY_ROOT / "scripts" / "deploy.sh",
    REPOSITORY_ROOT / "scripts" / "backup.sh",
    REPOSITORY_ROOT / "scripts" / "restore-verify.sh",
)


def test_posix_operations_scripts_are_present_and_non_destructive():
    for script_path in POSIX_SCRIPTS:
        script = script_path.read_text(encoding="utf-8")

        assert script.startswith("#!/usr/bin/env bash")
        assert "set -Eeuo pipefail" in script
        assert "docker compose" in script or "docker" in script
        assert "docker compose down --volumes" not in script
        assert "DROP DATABASE" not in script.upper()


def test_posix_deploy_and_restore_scripts_keep_release_and_backup_boundaries():
    deploy = (REPOSITORY_ROOT / "scripts" / "deploy.sh").read_text(encoding="utf-8")
    backup = (REPOSITORY_ROOT / "scripts" / "backup.sh").read_text(encoding="utf-8")
    restore = (REPOSITORY_ROOT / "scripts" / "restore-verify.sh").read_text(encoding="utf-8")
    build = (REPOSITORY_ROOT / "scripts" / "build_release.sh").read_text(encoding="utf-8")

    assert "ARTFLOW_RELEASE_SHA" in deploy
    assert "ARTFLOW_POSTGRES_IMAGE" in deploy
    assert "ARTFLOW_CADDY_IMAGE" in deploy
    assert "@sha256:" in deploy
    assert "ARTFLOW_PYTHON_IMAGE" in build
    assert "ARTFLOW_BUILD_SHA" in build
    assert "docker save" in build
    assert "--wait" in deploy
    assert "/healthz/" in deploy
    assert "backup_artflow" in backup
    assert "/app/backups" in backup
    assert "pg_restore" in restore
    assert "verify_app_backup" in restore
    assert "org.opencontainers.image.revision" in restore


def test_posix_restore_waits_for_the_stable_postgres_server():
    restore = (REPOSITORY_ROOT / "scripts" / "restore-verify.sh").read_text(encoding="utf-8")

    assert 'chmod 0755 "$media_extract_dir"' in restore
    assert "PostgreSQL init process complete; ready for start up." in restore
    assert "docker logs --tail 80" in restore
    assert restore.count("--command 'SELECT 1;'") == 2
    assert "sleep 1" in restore
    assert "pg_isready" not in restore


def test_deploy_gate_digest_pins_every_image_the_manifest_names():
    """Documented digest pinning has to be checked, not merely described.

    `.env.production.example` requires a verified immutable manifest digest for every
    production image, and the manifest names four. The gate read and validated postgres
    and caddy only, so `ARTFLOW_REDIS_IMAGE=redis:latest` could reach a real deployment
    through a gate that reported success.
    """
    deploy = (REPOSITORY_ROOT / "scripts" / "deploy.sh").read_text(encoding="utf-8")
    rendered_read = deploy[deploy.index("read -r release_sha") : deploy.index('[[ "$release_sha"')]

    for service, variable in (
        ("db", "postgres_image"),
        ("proxy", "caddy_image"),
        ("redis", "redis_image"),
    ):
        assert f'config["services"]["{service}"]' in rendered_read
        assert f'is_digest_image "${variable}"' in deploy


def test_monitor_treats_the_media_pool_as_mandatory():
    """A dead media pool must fail the monitor, not just break the downloads.

    Caddy routes /media/* to a Gunicorn pool of its own. Checking only db/web/proxy let
    the monitor report a pass while every accompaniment, attachment and generated
    document was unreachable. `realtime` stays out of the hard set on purpose: it is
    designed to degrade to HTTP.
    """
    monitor = (REPOSITORY_ROOT / "scripts" / "monitor.sh").read_text(encoding="utf-8")

    assert "for service in db web media proxy; do" in monitor
    assert "for service in db web proxy; do" not in monitor


def test_production_hostname_validator_accepts_hostnames_only():
    valid = ("artflow.example.com", "artflow.internal", "xn--fiq228c.example")
    invalid = (
        "",
        "https://artflow.example.com",
        "artflow.example.com:443",
        "artflow.example.com/healthz/",
        "artflow_example.com",
        "localhost",
    )

    for hostname in valid:
        result = subprocess.run([sys.executable, str(HOSTNAME_VALIDATOR), hostname], check=False)
        assert result.returncode == 0, hostname
    for value in invalid:
        result = subprocess.run([sys.executable, str(HOSTNAME_VALIDATOR), value], check=False)
        assert result.returncode == 64, value


def test_production_operations_require_the_hostname_contract_and_https_smoke():
    deploy = (REPOSITORY_ROOT / "scripts" / "deploy.sh").read_text(encoding="utf-8")
    monitor = (REPOSITORY_ROOT / "scripts" / "monitor.sh").read_text(encoding="utf-8")

    for script in (deploy, monitor):
        assert "validate_production_hostname.py" in script
        assert 'health_url="https://$site_address/healthz/"' in script
        assert "http://*|https://*" not in script
