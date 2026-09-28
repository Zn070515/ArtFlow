#!/usr/bin/env bash
set -Eeuo pipefail

die() {
    printf 'application restore verification: %s\n' "$1" >&2
    exit 64
}

if (( $# != 1 )); then
    die 'usage: restore-verify.sh BACKUP_SET'
fi

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
backup_set="$(cd -- "$1" && pwd -P)" || die 'backup set does not exist'
compose_project="${ARTFLOW_COMPOSE_PROJECT:-artflow}"
compose_file="${ARTFLOW_COMPOSE_FILE:-$repository_root/deploy/compose.production.yml}"
restore_database="${ARTFLOW_RESTORE_DATABASE:-artflow_restore}"
network="${compose_project}_artflow_internal"
restore_container="${compose_project}-backup-restore-${RANDOM}${RANDOM}"
media_extract_dir="$(mktemp -d)"
chmod 0755 "$media_extract_dir"

[[ "$compose_project" =~ ^[A-Za-z0-9_-]+$ ]] || die 'invalid Compose project name'
[[ "$restore_database" =~ ^[A-Za-z_][A-Za-z0-9_-]*$ ]] || die 'invalid restore database name'
command -v docker >/dev/null 2>&1 || die 'docker is required'
command -v python3 >/dev/null 2>&1 || die 'python3 is required to read the manifest'
command -v sha256sum >/dev/null 2>&1 || die 'sha256sum is required'
command -v tar >/dev/null 2>&1 || die 'tar is required'

cleanup() {
    docker rm -f "$restore_container" >/dev/null 2>&1 || true
    rm -rf -- "$media_extract_dir"
}
trap cleanup EXIT

restore_diagnostics() {
    printf 'restore container status: %s\n' "$restore_container" >&2
    docker inspect -f '{{.State.Status}}' "$restore_container" >&2 2>/dev/null || true
    printf 'restore container logs (last 80 lines):\n' >&2
    docker logs --tail 80 "$restore_container" >&2 2>/dev/null || true
}

wait_for_stable_restore_database() {
    local deadline=$((SECONDS + 90))
    local init_complete_marker='PostgreSQL init process complete; ready for start up.'
    local state logs

    while (( SECONDS < deadline )); do
        state="$(docker inspect -f '{{.State.Status}}' "$restore_container" 2>/dev/null || true)"
        if [[ "$state" == 'exited' || "$state" == 'dead' ]]; then
            restore_diagnostics
            die 'isolated PostgreSQL restore container stopped before becoming stable'
        fi
        if [[ "$state" != 'running' ]]; then
            sleep 1
            continue
        fi

        logs="$(docker logs --tail 80 "$restore_container" 2>/dev/null || true)"
        if [[ "$logs" != *"$init_complete_marker"* ]]; then
            sleep 1
            continue
        fi

        if ! docker exec "$restore_container" psql \
            --username postgres --dbname "$restore_database" \
            --tuples-only --no-align --command 'SELECT 1;' \
            >/dev/null 2>&1; then
            sleep 1
            continue
        fi

        sleep 1
        if docker exec "$restore_container" psql \
            --username postgres --dbname "$restore_database" \
            --tuples-only --no-align --command 'SELECT 1;' \
            >/dev/null 2>&1; then
            return 0
        fi
        sleep 1
    done

    restore_diagnostics
    die 'isolated PostgreSQL restore database did not become stable within 90 seconds'
}

for required in manifest.json database.dump media.tar.gz; do
    [[ -f "$backup_set/$required" ]] || die "backup set is missing $required"
done

read -r manifest_sha expected_database expected_media < <(
    python3 - "$backup_set/manifest.json" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as manifest_file:
    manifest = json.load(manifest_file)
print(manifest.get("git_sha", ""), manifest.get("database_sha256", ""), manifest.get("media_sha256", ""))
PY
)
[[ "$manifest_sha" =~ ^[0-9a-fA-F]{40}$ ]] || die 'manifest git_sha is invalid'
[[ "$expected_database" =~ ^[0-9a-fA-F]{64}$ ]] || die 'manifest database_sha256 is invalid'
[[ "$expected_media" =~ ^[0-9a-fA-F]{64}$ ]] || die 'manifest media_sha256 is invalid'
[[ "$(sha256sum "$backup_set/database.dump" | awk '{print $1}')" == "${expected_database,,}" ]] \
    || die 'database_sha256 does not match'
[[ "$(sha256sum "$backup_set/media.tar.gz" | awk '{print $1}')" == "${expected_media,,}" ]] \
    || die 'media_sha256 does not match'

compose=(docker compose --env-file "${ARTFLOW_ENV_FILE:-$repository_root/.env.production}" -p "$compose_project" -f "$compose_file")
web_container="$("${compose[@]}" ps -q web)"
db_container="$("${compose[@]}" ps -q db)"
[[ -n "$web_container" && -n "$db_container" ]] || die 'source Compose web and db services must be running'
web_image="$(docker inspect -f '{{.Config.Image}}' "$web_container")"
db_image="$(docker inspect -f '{{.Config.Image}}' "$db_container")"
web_revision="$(docker inspect -f '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$web_container")"
[[ "$web_revision" == "$manifest_sha" ]] || die 'running web image revision does not match the backup manifest'

tar -xzf "$backup_set/media.tar.gz" -C "$media_extract_dir"
docker run --rm --network "$network" --name "$restore_container" -d \
    -e POSTGRES_PASSWORD=restore-only -e POSTGRES_DB="$restore_database" \
    "$db_image" >/dev/null
wait_for_stable_restore_database

docker cp "$backup_set/database.dump" "$restore_container:/tmp/artflow-verify.dump"
docker exec "$restore_container" pg_restore --list /tmp/artflow-verify.dump >/dev/null
docker exec "$restore_container" pg_restore --username postgres --exit-on-error --no-owner \
    --dbname "$restore_database" /tmp/artflow-verify.dump >/dev/null
docker exec "$restore_container" psql --username postgres --dbname "$restore_database" \
    --tuples-only --no-align --command 'SELECT 1 FROM django_migrations LIMIT 1;' >/dev/null

docker run --rm --network "$network" --entrypoint python \
    -e APP_ENV=development -e DEBUG=False -e DATABASE_ENGINE=postgresql \
    -e POSTGRES_DB="$restore_database" -e POSTGRES_USER=postgres \
    -e POSTGRES_PASSWORD=restore-only -e POSTGRES_HOST="$restore_container" -e POSTGRES_PORT=5432 \
    -v "$media_extract_dir:/app/media:ro" -v "$backup_set:/backup:ro" \
    "$web_image" manage.py check
docker run --rm --network "$network" --entrypoint python \
    -e APP_ENV=development -e DEBUG=False -e DATABASE_ENGINE=postgresql \
    -e POSTGRES_DB="$restore_database" -e POSTGRES_USER=postgres \
    -e POSTGRES_PASSWORD=restore-only -e POSTGRES_HOST="$restore_container" -e POSTGRES_PORT=5432 \
    -v "$media_extract_dir:/app/media:ro" -v "$backup_set:/backup:ro" \
    "$web_image" manage.py verify_app_backup --manifest /backup/manifest.json
printf 'application backup restore verification passed; source services and volumes were not reset.\n'
