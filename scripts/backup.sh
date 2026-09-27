#!/usr/bin/env bash
set -Eeuo pipefail

die() {
    printf 'application backup: %s\n' "$1" >&2
    exit 64
}

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
output_root="${1:-$repository_root/backups}"
compose_project="${ARTFLOW_COMPOSE_PROJECT:-artflow}"
compose_file="${ARTFLOW_COMPOSE_FILE:-$repository_root/deploy/compose.production.yml}"
container_backup_base="${ARTFLOW_CONTAINER_BACKUP_BASE:-/app/backups}"
git_sha="${2:-}"

[[ "$compose_project" =~ ^[A-Za-z0-9_-]+$ ]] || die 'invalid Compose project name'
[[ "$container_backup_base" == /* ]] || die 'container backup path must be absolute'
command -v docker >/dev/null 2>&1 || die 'docker is required'
mkdir -p -- "$output_root"

compose=(docker compose --env-file "${ARTFLOW_ENV_FILE:-$repository_root/.env.production}" -p "$compose_project" -f "$compose_file")
web_container="$("${compose[@]}" ps -q web)"
[[ -n "$web_container" ]] || die 'the Compose web service is not running'

backup_output="$(
    if [[ -n "$git_sha" ]]; then
        "${compose[@]}" exec -T web python manage.py backup_artflow --output "$container_backup_base" --git-sha "$git_sha"
    else
        "${compose[@]}" exec -T web python manage.py backup_artflow --output "$container_backup_base"
    fi
)"
container_backup_dir="$(printf '%s\n' "$backup_output" | awk 'NF { last = $0 } END { print last }')"
[[ "$container_backup_dir" == /* ]] || die 'backup command did not return a container path'

docker cp "$web_container:$container_backup_dir" "$output_root/"
local_backup_dir="$output_root/$(basename -- "$container_backup_dir")"
for required in manifest.json database.dump media.tar.gz; do
    [[ -f "$local_backup_dir/$required" ]] || die "copied backup is missing $required"
done
if [[ -n "${ARTFLOW_OFFSITE_BUCKET:-}" ]]; then
    "$(dirname -- "${BASH_SOURCE[0]}")/offsite_backup.sh" "$local_backup_dir"
fi
printf '%s\n' "$local_backup_dir"
