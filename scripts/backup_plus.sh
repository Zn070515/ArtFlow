#!/usr/bin/env bash
set -Eeuo pipefail

die() {
    printf 'Plus backup: %s\n' "$1" >&2
    exit 64
}

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
output_root="${1:-$repository_root/backups/artflow-plus}"
compose_project="${ARTFLOW_COMPOSE_PROJECT:-artflow}"
compose_file="${ARTFLOW_COMPOSE_FILE:-$repository_root/deploy/compose.production.yml}"
env_file="${ARTFLOW_ENV_FILE:-$repository_root/.env.production}"

[[ "$compose_project" =~ ^[A-Za-z0-9_-]+$ ]] || die 'invalid Compose project name'
[[ -f "$compose_file" ]] || die "Compose file does not exist: $compose_file"
[[ -f "$env_file" ]] || die "environment file does not exist: $env_file"
command -v docker >/dev/null 2>&1 || die 'docker is required'
command -v python3 >/dev/null 2>&1 || die 'python3 is required to write the manifest'
command -v sha256sum >/dev/null 2>&1 || die 'sha256sum is required'
mkdir -p -- "$output_root"

compose=(docker compose --env-file "$env_file" -p "$compose_project" -f "$compose_file" --profile plus)
db_container="$("${compose[@]}" ps -q plus-db)"
api_container="$("${compose[@]}" ps -q plus-api)"
[[ -n "$db_container" ]] || die 'the Compose plus-db service is not running'
[[ -n "$api_container" ]] || die 'the Compose plus-api service is not running'
[[ "$(docker inspect -f '{{.State.Running}}' "$db_container")" == 'true' ]] || die 'the Compose plus-db service is not running'
[[ "$(docker inspect -f '{{.State.Running}}' "$api_container")" == 'true' ]] || die 'the Compose plus-api service is not running'

db_image="$(docker inspect -f '{{.Config.Image}}' "$db_container")"
api_image="$(docker inspect -f '{{.Config.Image}}' "$api_container")"
git_sha="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$api_container" | sed -n 's/^ARTFLOW_RELEASE_SHA=//p' | head -n 1)"
[[ "$git_sha" =~ ^[0-9a-fA-F]{40}$ ]] || die 'running plus-api has no valid ARTFLOW_RELEASE_SHA'

# These are the two Plus file surfaces. The read-only v1 media bridge is deliberately
# excluded: it belongs to the v1 backup and is not authoritative Plus material.
archive_volume="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/app/var/archives"}}{{.Name}}{{end}}{{end}}' "$api_container")"
media_volume="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/app/var/media"}}{{.Name}}{{end}}{{end}}' "$api_container")"
[[ "$archive_volume" == *plus_archive_data* ]] || die 'plus_archive_data is not mounted at /app/var/archives'
[[ "$media_volume" == *plus_media_data* ]] || die 'plus_media_data is not mounted at /app/var/media'

created_at="$(date -u +%Y%m%dT%H%M%SZ)"
backup_set="$output_root/${created_at}-${git_sha}"
[[ ! -e "$backup_set" ]] || die "backup set already exists: $backup_set"
mkdir -p -- "$backup_set"

source_dump_path="/tmp/artflow-plus-backup-${created_at}-${RANDOM}.dump"
cleanup() {
    if [[ -n "${source_dump_path:-}" && -n "${db_container:-}" ]]; then
        docker exec "$db_container" rm -f "$source_dump_path" >/dev/null 2>&1 || true
    fi
}
trap cleanup EXIT

docker exec "$db_container" sh -c \
    'pg_dump --format=custom --no-owner --file="$1" --username="$POSTGRES_USER" --dbname="$POSTGRES_DB"' \
    sh "$source_dump_path"
docker cp "$db_container:$source_dump_path" "$backup_set/database.dump"

docker run --rm \
    --mount "type=volume,source=$archive_volume,target=/data,readonly" \
    --entrypoint tar "$api_image" -czf - -C /data . > "$backup_set/archives.tar.gz"
docker run --rm \
    --mount "type=volume,source=$media_volume,target=/data,readonly" \
    --entrypoint tar "$api_image" -czf - -C /data . > "$backup_set/media.tar.gz"

for artifact in database.dump archives.tar.gz media.tar.gz; do
    [[ -s "$backup_set/$artifact" ]] || die "backup artifact is empty: $artifact"
done

database_sha256="$(sha256sum "$backup_set/database.dump" | awk '{print $1}')"
archives_sha256="$(sha256sum "$backup_set/archives.tar.gz" | awk '{print $1}')"
media_sha256="$(sha256sum "$backup_set/media.tar.gz" | awk '{print $1}')"
database_bytes="$(wc -c < "$backup_set/database.dump" | tr -d '[:space:]')"
archives_bytes="$(wc -c < "$backup_set/archives.tar.gz" | tr -d '[:space:]')"
media_bytes="$(wc -c < "$backup_set/media.tar.gz" | tr -d '[:space:]')"

archive_regular_files="$(python3 - "$backup_set/archives.tar.gz" <<'PY'
import sys
import tarfile

with tarfile.open(sys.argv[1], mode="r:gz") as archive:
    print(sum(member.isfile() for member in archive.getmembers()))
PY
)"
media_regular_files="$(python3 - "$backup_set/media.tar.gz" <<'PY'
import sys
import tarfile

with tarfile.open(sys.argv[1], mode="r:gz") as archive:
    print(sum(member.isfile() for member in archive.getmembers()))
PY
)"

PLUS_BACKUP_CREATED_AT="$created_at" \
PLUS_BACKUP_GIT_SHA="$git_sha" \
PLUS_BACKUP_COMPOSE_PROJECT="$compose_project" \
PLUS_BACKUP_DATABASE_IMAGE="$db_image" \
PLUS_BACKUP_API_IMAGE="$api_image" \
PLUS_BACKUP_ARCHIVE_VOLUME="$archive_volume" \
PLUS_BACKUP_MEDIA_VOLUME="$media_volume" \
PLUS_BACKUP_DATABASE_SHA256="$database_sha256" \
PLUS_BACKUP_ARCHIVES_SHA256="$archives_sha256" \
PLUS_BACKUP_MEDIA_SHA256="$media_sha256" \
PLUS_BACKUP_DATABASE_BYTES="$database_bytes" \
PLUS_BACKUP_ARCHIVES_BYTES="$archives_bytes" \
PLUS_BACKUP_MEDIA_BYTES="$media_bytes" \
PLUS_BACKUP_ARCHIVE_FILES="$archive_regular_files" \
PLUS_BACKUP_MEDIA_FILES="$media_regular_files" \
python3 - "$backup_set/manifest.json.tmp" "$backup_set/manifest.json" <<'PY'
import json
import os
import sys

manifest = {
    "schema": "artflow-plus-backup/v1",
    "created_at": os.environ["PLUS_BACKUP_CREATED_AT"],
    "git_sha": os.environ["PLUS_BACKUP_GIT_SHA"].lower(),
    "compose_project": os.environ["PLUS_BACKUP_COMPOSE_PROJECT"],
    "database_image": os.environ["PLUS_BACKUP_DATABASE_IMAGE"],
    "api_image": os.environ["PLUS_BACKUP_API_IMAGE"],
    "archive_volume": os.environ["PLUS_BACKUP_ARCHIVE_VOLUME"],
    "media_volume": os.environ["PLUS_BACKUP_MEDIA_VOLUME"],
    "database_file": "database.dump",
    "archives_file": "archives.tar.gz",
    "media_file": "media.tar.gz",
    "database_sha256": os.environ["PLUS_BACKUP_DATABASE_SHA256"],
    "archives_sha256": os.environ["PLUS_BACKUP_ARCHIVES_SHA256"],
    "media_sha256": os.environ["PLUS_BACKUP_MEDIA_SHA256"],
    "database_bytes": int(os.environ["PLUS_BACKUP_DATABASE_BYTES"]),
    "archives_bytes": int(os.environ["PLUS_BACKUP_ARCHIVES_BYTES"]),
    "media_bytes": int(os.environ["PLUS_BACKUP_MEDIA_BYTES"]),
    "archive_regular_files": int(os.environ["PLUS_BACKUP_ARCHIVE_FILES"]),
    "media_regular_files": int(os.environ["PLUS_BACKUP_MEDIA_FILES"]),
}
with open(sys.argv[1], "w", encoding="utf-8") as manifest_file:
    json.dump(manifest, manifest_file, ensure_ascii=False, indent=2, sort_keys=True)
    manifest_file.write("\n")
os.replace(sys.argv[1], sys.argv[2])
PY

printf '%s\n' "$backup_set"
