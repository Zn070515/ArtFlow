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
hostname_validator="$repository_root/scripts/validate_production_hostname.py"
[[ -f "$hostname_validator" ]] || die 'production hostname validator is missing'

is_digest_image() {
    [[ "$1" =~ ^[^[:space:]@]+@sha256:[0-9a-fA-F]{64}$ ]]
}

is_release_image() {
    [[ "$1" == *":$release_sha" || "$1" == *":$release_sha@sha256:"* ]]
}

compose=(docker compose --env-file "$env_file" -p "$compose_project" -f "$compose_file")
"${compose[@]}" config --quiet
rendered="$("${compose[@]}" config --format json)"
read -r release_sha site_address web_image postgres_image caddy_image < <(
    printf '%s' "$rendered" | python3 -c '
import json
import sys

config = json.load(sys.stdin)
web = config["services"]["web"]
proxy = config["services"]["proxy"]
db = config["services"]["db"]
print(
    web["environment"]["ARTFLOW_RELEASE_SHA"],
    proxy["environment"]["CADDY_SITE_ADDRESS"],
    web["image"],
    db["image"],
    proxy["image"],
)
'
)
[[ "$release_sha" =~ ^[0-9a-fA-F]{40}$ ]] || die 'production build must use a full ARTFLOW_RELEASE_SHA'
python3 "$hostname_validator" "$site_address" \
    || die 'CADDY_SITE_ADDRESS must be a hostname without a scheme, port, or path'
is_release_image "$web_image" || die 'ARTFLOW_WEB_IMAGE must carry the deployed release SHA'
is_digest_image "$postgres_image" || die 'ARTFLOW_POSTGRES_IMAGE must use a verified digest'
is_digest_image "$caddy_image" || die 'ARTFLOW_CADDY_IMAGE must use a verified digest'
web_revision="$(docker image inspect -f '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$web_image" 2>/dev/null)" \
    || die 'the prebuilt web image is not loaded locally'
[[ "$web_revision" == "$release_sha" ]] || die 'prebuilt web image revision does not match ARTFLOW_RELEASE_SHA'

"${compose[@]}" up --no-build --pull never --wait
"${compose[@]}" exec -T web python manage.py doctor

health_url="https://$site_address/healthz/"
curl --fail --silent --show-error --max-time 20 "$health_url" >/dev/null
printf 'production deployment and external health check passed for %s\n' "$release_sha"
