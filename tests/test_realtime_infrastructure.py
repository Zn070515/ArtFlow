from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]


def test_realtime_runtime_is_a_separate_process_without_duplicate_bootstrap():
    compose = (REPOSITORY_ROOT / "deploy" / "compose.production.yml").read_text()
    dockerfile = (REPOSITORY_ROOT / "Dockerfile").read_text()
    entrypoint = (REPOSITORY_ROOT / "scripts" / "docker-entrypoint.sh").read_text()

    assert "realtime:" in compose
    assert "ARTFLOW_PROCESS_ROLE: realtime" in compose
    assert "COPY --chown=artflow:artflow realtime ./realtime" in dockerfile
    assert (
        'command: ["daphne", "-b", "0.0.0.0", "-p", "8001", "config.asgi:application"]' in compose
    )
    assert "ARTFLOW_PROCESS_ROLE must be web or realtime" in entrypoint
    assert 'process_role="${ARTFLOW_PROCESS_ROLE:-web}"' in entrypoint
    assert "python manage.py migrate --noinput" in entrypoint


def test_caddy_routes_only_websocket_paths_to_realtime():
    caddy = (REPOSITORY_ROOT / "deploy" / "Caddyfile").read_text()

    assert "@realtime path /ws/*" in caddy
    assert "reverse_proxy @realtime realtime:8001" in caddy
    assert "reverse_proxy web:8000" in caddy
