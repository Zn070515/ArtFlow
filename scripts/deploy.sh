#!/usr/bin/env bash
set -Eeuo pipefail

die() {
    printf 'production deploy: %s\n' "$1" >&2
    exit 64
}

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
env_file="${1:-$repository_root/.env.production}"
compose_project="${ARTFLOW_COMPOSE_PROJECT:-artflow}"
compose_file="$repository_root/deploy/compose.production.yml"

[[ -f "$env_file" ]] || die "environment file not found: $env_file"
[[ "$compose_project" =~ ^[A-Za-z0-9_-]+$ ]] || die 'invalid Compose project name'
command -v docker >/dev/null 2>&1 || die 'docker is required'
command -v python3 >/dev/null 2>&1 || die 'python3 is required to inspect the rendered manifest'
command -v curl >/dev/null 2>&1 || die 'curl is required for the external HTTPS smoke check'

compose=(docker compose --env-file "$env_file" -p "$compose_project" -f "$compose_file")
"${compose[@]}" config --quiet
rendered="$(${compose[@]} config --format json)"
read -r release_sha site_address < <(
    printf '%s' "$rendered" | python3 -c '
import json
import sys

config = json.load(sys.stdin)
web = config["services"]["web"]
proxy = config["services"]["proxy"]
print(web["build"]["args"]["ARTFLOW_BUILD_SHA"], proxy["environment"]["CADDY_SITE_ADDRESS"])
'
)
[[ "$release_sha" =~ ^[0-9a-fA-F]{40}$ ]] || die 'production build must use a full ARTFLOW_RELEASE_SHA'
[[ -n "$site_address" ]] || die 'production proxy site address is empty'

"${compose[@]}" up --build --wait
"${compose[@]}" exec -T web python manage.py doctor

case "$site_address" in
    http://*|https://*) health_url="$site_address/healthz/" ;;
    *) health_url="https://$site_address/healthz/" ;;
esac
curl --fail --silent --show-error --max-time 20 "$health_url" >/dev/null
printf 'production deployment and external health check passed for %s\n' "$release_sha"
