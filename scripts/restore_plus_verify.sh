#!/usr/bin/env bash
set -Eeuo pipefail

# Git Bash/MSYS rewrites Unix-looking Docker arguments as Windows host paths.
# Container paths such as /tmp and /app must reach Docker unchanged.
export MSYS_NO_PATHCONV=1

die() {
    printf 'Plus restore verification: %s\n' "$1" >&2
    exit 64
}

docker_host_path() {
    if command -v cygpath >/dev/null 2>&1; then
        cygpath -w -- "$1"
    else
        printf '%s\n' "$1"
    fi
}

python_bin=""
for candidate in python3 python; do
    if command -v "$candidate" >/dev/null 2>&1 && \
        "$candidate" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 12) else 1)' >/dev/null 2>&1; then
        python_bin="$candidate"
        break
    fi
done
[[ -n "$python_bin" ]] || die 'a working Python 3 interpreter is required'

if (( $# != 1 )); then
    die 'usage: restore_plus_verify.sh BACKUP_SET'
fi

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
backup_set="$(cd -- "$1" 2>/dev/null && pwd -P)" || die 'backup set does not exist'
compose_project="${ARTFLOW_COMPOSE_PROJECT:-artflow}"
compose_file="${ARTFLOW_COMPOSE_FILE:-$repository_root/deploy/compose.production.yml}"
env_file="${ARTFLOW_ENV_FILE:-$repository_root/.env.production}"
restore_database="${ARTFLOW_RESTORE_DATABASE:-artflow_plus_restore}"

[[ "$compose_project" =~ ^[A-Za-z0-9_-]+$ ]] || die 'invalid Compose project name'
[[ "$restore_database" =~ ^[A-Za-z_][A-Za-z0-9_-]*$ ]] || die 'invalid restore database name'
[[ -f "$compose_file" ]] || die "Compose file does not exist: $compose_file"
[[ -f "$env_file" ]] || die "environment file does not exist: $env_file"
command -v docker >/dev/null 2>&1 || die 'docker is required'
command -v sha256sum >/dev/null 2>&1 || die 'sha256sum is required'
if [[ -x /usr/bin/find ]]; then
    find_bin=/usr/bin/find
else
    find_bin="$(command -v find)"
fi
[[ -x "$find_bin" ]] || die 'find is required'

manifest="$backup_set/manifest.json"
[[ -f "$manifest" ]] || die 'backup set is missing manifest.json'

mapfile -t manifest_values < <("$python_bin" - "$(docker_host_path "$manifest")" <<'PY'
import json
import re
import sys

path = sys.argv[1]
with open(path, encoding="utf-8") as manifest_file:
    value = json.load(manifest_file)

if value.get("schema") != "artflow-plus-backup/v1":
    raise SystemExit("unsupported Plus backup schema")

sha40 = re.compile(r"^[0-9a-fA-F]{40}$")
sha64 = re.compile(r"^[0-9a-fA-F]{64}$")
if not sha40.fullmatch(value.get("git_sha", "")):
    raise SystemExit("manifest git_sha is invalid")
for field in ("database_sha256", "archives_sha256", "media_sha256"):
    if not sha64.fullmatch(value.get(field, "")):
        raise SystemExit(f"manifest {field} is invalid")

expected_files = {
    "database_file": "database.dump",
    "archives_file": "archives.tar.gz",
    "media_file": "media.tar.gz",
}
for field, expected in expected_files.items():
    if value.get(field) != expected:
        raise SystemExit(f"manifest {field} is invalid")

for field in (
    "database_bytes",
    "archives_bytes",
    "media_bytes",
    "archive_regular_files",
    "media_regular_files",
):
    if not isinstance(value.get(field), int) or value[field] < 0:
        raise SystemExit(f"manifest {field} is invalid")

for field in ("database_image", "api_image", "compose_project"):
    if not isinstance(value.get(field), str) or not value[field]:
        raise SystemExit(f"manifest {field} is invalid")

print(value["git_sha"].lower())
print(value["database_sha256"].lower())
print(value["archives_sha256"].lower())
print(value["media_sha256"].lower())
print(value["database_image"])
print(value["api_image"])
print(value["compose_project"])
print(value["database_file"])
print(value["archives_file"])
print(value["media_file"])
print(value["database_bytes"])
print(value["archives_bytes"])
print(value["media_bytes"])
print(value["archive_regular_files"])
print(value["media_regular_files"])
PY
)
for index in "${!manifest_values[@]}"; do
    manifest_values[$index]="${manifest_values[$index]%$'\r'}"
done
(( ${#manifest_values[@]} == 15 )) || die 'manifest validation failed'
manifest_git_sha="${manifest_values[0]}"
expected_database_sha256="${manifest_values[1]}"
expected_archives_sha256="${manifest_values[2]}"
expected_media_sha256="${manifest_values[3]}"
manifest_database_image="${manifest_values[4]}"
manifest_api_image="${manifest_values[5]}"
manifest_compose_project="${manifest_values[6]}"
database_file="${manifest_values[7]}"
archives_file="${manifest_values[8]}"
media_file="${manifest_values[9]}"
expected_database_bytes="${manifest_values[10]}"
expected_archives_bytes="${manifest_values[11]}"
expected_media_bytes="${manifest_values[12]}"
expected_archive_files="${manifest_values[13]}"
expected_media_files="${manifest_values[14]}"
[[ "$manifest_compose_project" == "$compose_project" ]] || die 'backup belongs to a different Compose project'

for required in "$database_file" "$archives_file" "$media_file"; do
    [[ -f "$backup_set/$required" ]] || die "backup set is missing $required"
done

sha256_of() {
    sha256sum "$1" | awk '{print tolower($1)}'
}

[[ "$(sha256_of "$backup_set/$database_file")" == "$expected_database_sha256" ]] || die 'database_sha256 does not match'
[[ "$(sha256_of "$backup_set/$archives_file")" == "$expected_archives_sha256" ]] || die 'archives_sha256 does not match'
[[ "$(sha256_of "$backup_set/$media_file")" == "$expected_media_sha256" ]] || die 'media_sha256 does not match'
[[ "$(wc -c < "$backup_set/$database_file" | tr -d '[:space:]')" == "$expected_database_bytes" ]] || die 'database byte count does not match'
[[ "$(wc -c < "$backup_set/$archives_file" | tr -d '[:space:]')" == "$expected_archives_bytes" ]] || die 'archives byte count does not match'
[[ "$(wc -c < "$backup_set/$media_file" | tr -d '[:space:]')" == "$expected_media_bytes" ]] || die 'media byte count does not match'

compose=(docker compose --env-file "$(docker_host_path "$env_file")" -p "$compose_project" -f "$(docker_host_path "$compose_file")" --profile plus)
source_db_container="$("${compose[@]}" ps -q plus-db)"
source_api_container="$("${compose[@]}" ps -q plus-api)"
[[ -n "$source_db_container" ]] || die 'the Compose plus-db service is not running'
[[ -n "$source_api_container" ]] || die 'the Compose plus-api service is not running'
[[ "$(docker inspect -f '{{.State.Running}}' "$source_db_container")" == 'true' ]] || die 'the Compose plus-db service is not running'
[[ "$(docker inspect -f '{{.State.Running}}' "$source_api_container")" == 'true' ]] || die 'the Compose plus-api service is not running'

source_db_image="$(docker inspect -f '{{.Config.Image}}' "$source_db_container")"
source_api_image="$(docker inspect -f '{{.Config.Image}}' "$source_api_container")"
source_api_revision="$(docker inspect -f '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$source_api_container")"
source_release_sha="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$source_api_container" | sed -n 's/^ARTFLOW_RELEASE_SHA=//p' | head -n 1)"
[[ "$source_db_image" == "$manifest_database_image" ]] || die 'running plus-db image does not match the backup manifest'
[[ "$source_api_image" == "$manifest_api_image" ]] || die 'running plus-api image does not match the backup manifest'
[[ "$source_api_revision" == "$manifest_git_sha" ]] || die 'running plus-api OCI revision does not match the backup manifest'
[[ "$source_release_sha" == "$manifest_git_sha" ]] || die 'running plus-api release SHA does not match the backup manifest'

network="$(docker inspect -f '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}' "$source_api_container" | grep -E '(^|_)artflow_internal$' | head -n 1 || true)"
[[ -n "$network" ]] || die 'could not find the Plus internal Docker network'

archive_extract_dir="$(mktemp -d)"
media_extract_dir="$(mktemp -d)"
restore_db_container="${compose_project}-plus-restore-db-${RANDOM}${RANDOM}"
restore_api_container="${compose_project}-plus-restore-api-${RANDOM}${RANDOM}"

cleanup() {
    docker rm -f "$restore_api_container" >/dev/null 2>&1 || true
    docker rm -f "$restore_db_container" >/dev/null 2>&1 || true
    rm -rf -- "$archive_extract_dir" "$media_extract_dir"
}
trap cleanup EXIT

extract_safe() {
    local archive="$1"
    local destination="$2"
    "$python_bin" - "$(docker_host_path "$archive")" "$(docker_host_path "$destination")" <<'PY'
import sys
import tarfile
from pathlib import Path, PurePosixPath

archive_path = sys.argv[1]
destination = Path(sys.argv[2]).resolve()
with tarfile.open(archive_path, mode="r:gz") as tar:
    members = tar.getmembers()
    for member in members:
        name = member.name
        parts = PurePosixPath(name).parts
        if not name or PurePosixPath(name).is_absolute() or ".." in parts or "\x00" in name:
            raise SystemExit(f"unsafe archive path: {name!r}")
        if member.issym():
            raise SystemExit(f"symlink members are not allowed: {name!r}")
        if member.islnk():
            raise SystemExit(f"hardlink members are not allowed: {name!r}")
        if not (member.isdir() or member.isfile()):
            raise SystemExit(f"special tar members are not allowed: {name!r}")
        target = (destination / Path(*parts)).resolve()
        try:
            target.relative_to(destination)
        except ValueError as error:
            raise SystemExit(f"archive path escapes destination: {name!r}") from error
    for member in members:
        tar.extract(member, path=destination, set_attrs=False, filter="data")
PY
}

extract_safe "$backup_set/$archives_file" "$archive_extract_dir"
extract_safe "$backup_set/$media_file" "$media_extract_dir"
archive_files="$("$find_bin" "$archive_extract_dir" -type f -print | wc -l | tr -d '[:space:]')"
media_files="$("$find_bin" "$media_extract_dir" -type f -print | wc -l | tr -d '[:space:]')"
[[ "$archive_files" == "$expected_archive_files" ]] || die 'archive regular-file count does not match'
[[ "$media_files" == "$expected_media_files" ]] || die 'media regular-file count does not match'

restore_database_container() {
    docker run --rm --network "$network" --name "$restore_db_container" -d \
        -e POSTGRES_USER=postgres \
        -e POSTGRES_PASSWORD=restore-only \
        -e POSTGRES_DB="$restore_database" \
        "$manifest_database_image" >/dev/null
}

restore_database_diagnostics() {
    printf 'isolated database status: %s\n' "$restore_db_container" >&2
    docker inspect -f '{{.State.Status}}' "$restore_db_container" >&2 2>/dev/null || true
    docker logs --tail 80 "$restore_db_container" >&2 2>/dev/null || true
}

wait_for_restore_database() {
    local deadline=$((SECONDS + 90))
    local state
    while (( SECONDS < deadline )); do
        state="$(docker inspect -f '{{.State.Status}}' "$restore_db_container" 2>/dev/null || true)"
        if [[ "$state" == 'exited' || "$state" == 'dead' ]]; then
            restore_database_diagnostics
            die 'isolated PostgreSQL restore container stopped before becoming ready'
        fi
        if [[ "$state" == 'running' ]] && \
            docker exec "$restore_db_container" pg_isready -U postgres -d "$restore_database" >/dev/null 2>&1 && \
            docker exec "$restore_db_container" psql -U postgres -d "$restore_database" -At -c 'SELECT 1;' >/dev/null 2>&1; then
            sleep 1
            if docker exec "$restore_db_container" psql -U postgres -d "$restore_database" -At -c 'SELECT 1;' >/dev/null 2>&1; then
                return 0
            fi
        fi
        sleep 1
    done
    restore_database_diagnostics
    die 'isolated PostgreSQL restore database did not become stable within 90 seconds'
}

restore_database_container
wait_for_restore_database
docker cp "$(docker_host_path "$backup_set/$database_file")" "$restore_db_container:/tmp/artflow-plus-restore.dump"
docker exec "$restore_db_container" pg_restore --list /tmp/artflow-plus-restore.dump >/dev/null
docker exec "$restore_db_container" pg_restore --username postgres --exit-on-error --no-owner \
    --dbname "$restore_database" /tmp/artflow-plus-restore.dump >/dev/null
[[ "$(docker exec "$restore_db_container" psql -U postgres -d "$restore_database" -At \
    -c "SELECT to_regclass('public.kysely_migration') IS NOT NULL;" | tr -d '[:space:]')" == 't' ]] || \
    die 'restored database does not contain kysely_migration'

docker run --rm --network "$network" --name "$restore_api_container" -d \
    --entrypoint node \
    -e NODE_ENV=production \
    -e APP_ENV=production \
    -e HOST=0.0.0.0 \
    -e PORT=3000 \
    -e ARTFLOW_RELEASE_SHA="$manifest_git_sha" \
    -e ARTFLOW_PLUS_DATABASE_URL="postgresql://postgres:restore-only@${restore_db_container}:5432/${restore_database}" \
    -e ARTFLOW_PLUS_CREDENTIAL_SECRET=restore-only-secret \
    -e ARTFLOW_PLUS_INLINE_RELAY=0 \
    -e ARTFLOW_PLUS_ARCHIVE_DIR=/app/var/archives \
    -e ARTFLOW_PLUS_MEDIA_DIR=/app/var/media \
    --mount "type=bind,source=$(docker_host_path "$archive_extract_dir"),target=/app/var/archives,readonly" \
    --mount "type=bind,source=$(docker_host_path "$media_extract_dir"),target=/app/var/media,readonly" \
    "$manifest_api_image" main.cjs >/dev/null

api_diagnostics() {
    printf 'isolated API status: %s\n' "$restore_api_container" >&2
    docker inspect -f '{{.State.Status}}' "$restore_api_container" >&2 2>/dev/null || true
    docker logs --tail 120 "$restore_api_container" >&2 2>/dev/null || true
}

wait_for_restore_api() {
    local deadline=$((SECONDS + 90))
    local state
    local probe='fetch("http://PLACEHOLDER:3000/readyz").then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1));'
    probe="${probe/PLACEHOLDER/$restore_api_container}"
    while (( SECONDS < deadline )); do
        state="$(docker inspect -f '{{.State.Status}}' "$restore_api_container" 2>/dev/null || true)"
        if [[ "$state" == 'exited' || "$state" == 'dead' ]]; then
            api_diagnostics
            die 'isolated Plus API stopped before becoming ready'
        fi
        if [[ "$state" == 'running' ]] && docker run --rm --network "$network" --entrypoint node \
            "$manifest_api_image" -e "$probe" >/dev/null 2>&1; then
            return 0
        fi
        sleep 1
    done
    api_diagnostics
    die 'isolated Plus API did not become ready within 90 seconds'
}

wait_for_restore_api
printf 'Plus backup restore verification passed; source services and volumes were not reset.\n'
