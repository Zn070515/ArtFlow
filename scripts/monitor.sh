#!/usr/bin/env bash
set -Eeuo pipefail

die() {
    printf 'runtime monitor: %s\n' "$1" >&2
    exit 1
}

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
env_file="${1:-$repository_root/.env.production}"
compose_project="${ARTFLOW_COMPOSE_PROJECT:-artflow}"
compose_file="$repository_root/deploy/compose.production.yml"
data_path="${ARTFLOW_DATA_PATH:-/var/lib/docker}"
backup_root="${ARTFLOW_BACKUP_ROOT:-$repository_root/backups}"
max_backup_age="${ARTFLOW_MAX_BACKUP_AGE_SECONDS:-86400}"
min_free_mb="${ARTFLOW_MIN_FREE_MB:-1024}"

[[ -f "$env_file" ]] || die "environment file not found: $env_file"
[[ "$compose_project" =~ ^[A-Za-z0-9_-]+$ ]] || die 'invalid Compose project name'
command -v docker >/dev/null 2>&1 || die 'docker is required'
command -v python3 >/dev/null 2>&1 || die 'python3 is required'
command -v curl >/dev/null 2>&1 || die 'curl is required'
command -v df >/dev/null 2>&1 || die 'df is required'
hostname_validator="$repository_root/scripts/validate_production_hostname.py"
[[ -f "$hostname_validator" ]] || die 'production hostname validator is missing'

compose=(docker compose --env-file "$env_file" -p "$compose_project" -f "$compose_file")
"${compose[@]}" config --quiet
rendered="$("${compose[@]}" config --format json)"
site_address="$(printf '%s' "$rendered" | python3 -c 'import json,sys; print(json.load(sys.stdin)["services"]["proxy"]["environment"]["CADDY_SITE_ADDRESS"])')"
python3 "$hostname_validator" "$site_address" \
    || die 'CADDY_SITE_ADDRESS must be a hostname without a scheme, port, or path'

# `media` answers /media/* from its own pool, so a dead media worker means every
# accompaniment, attachment and generated document is broken while the site still
# answers /healthz/. It is part of the production topology, not an enhancement.
# `realtime` is deliberately absent: it degrades to HTTP by design, so its health is
# not a runtime failure.
for service in db web media proxy; do
    container="$("${compose[@]}" ps -q "$service")"
    [[ -n "$container" ]] || die "$service container is not running"
    status="$(docker inspect -f '{{.State.Health.Status}}' "$container")"
    [[ "$status" == healthy ]] || die "$service health status is $status"
done

health_url="https://$site_address/healthz/"
curl --fail --silent --show-error --max-time 20 "$health_url" >/dev/null

free_kb="$(df -Pk "$data_path" | awk 'NR == 2 { print $4 }')"
[[ "$free_kb" =~ ^[0-9]+$ ]] || die "could not read free space for $data_path"
(( free_kb >= min_free_mb * 1024 )) || die "free space below ${min_free_mb} MiB"

[[ -d "$backup_root" ]] || die "backup root not found: $backup_root"
latest_manifest="$(find "$backup_root" -type f -name manifest.json -printf '%T@ %p\n' | sort -nr | head -n 1 | cut -d' ' -f2-)"
[[ -n "$latest_manifest" ]] || die 'no application backup manifest found'
latest_epoch="$(stat -c '%Y' "$latest_manifest")"
now_epoch="$(date +%s)"
(( now_epoch - latest_epoch <= max_backup_age )) || die 'latest application backup is too old'

printf 'runtime monitor passed: services healthy, external health reachable, storage and backup freshness within policy.\n'
