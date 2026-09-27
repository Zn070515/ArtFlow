from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]


def test_runtime_operations_include_log_rotation_and_monitoring_contracts():
    logging_config = REPOSITORY_ROOT / "deploy" / "docker-daemon.json.example"
    monitor = REPOSITORY_ROOT / "scripts" / "monitor.sh"

    assert logging_config.is_file()
    assert monitor.is_file()
    assert '"max-size"' in logging_config.read_text(encoding="utf-8")
    assert '"max-file"' in logging_config.read_text(encoding="utf-8")

    monitor_contents = monitor.read_text(encoding="utf-8")
    assert "docker compose" in monitor_contents
    assert "/healthz/" in monitor_contents
    assert "df" in monitor_contents
    assert "backup" in monitor_contents.lower()
    assert "docker compose down --volumes" not in monitor_contents
