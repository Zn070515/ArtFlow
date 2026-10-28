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
base_rendered="$("${compose[@]}" config --format json)"
site_profile="$(printf '%s' "$base_rendered" | python3 -c '
import json
import sys

config = json.load(sys.stdin)
print(config["services"]["proxy"]["environment"].get("ARTFLOW_SITE_PROFILE", "v1"))
')"
case "$site_profile" in
    v1) ;;
    v2) compose+=(--profile plus) ;;
    *) die 'ARTFLOW_SITE_PROFILE must be v1 or v2' ;;
esac
"${compose[@]}" config --quiet
rendered="$("${compose[@]}" config --format json)"
read -r release_sha site_address web_image postgres_image caddy_image redis_image rendered_profile plus_api_image plus_worker_image plus_web_image plus_api_release plus_worker_release < <(
    printf '%s' "$rendered" | python3 -c '
import json
import sys

config = json.load(sys.stdin)
web = config["services"]["web"]
proxy = config["services"]["proxy"]
db = config["services"]["db"]
redis = config["services"]["redis"]
plus_api = config["services"].get("plus-api", {})
plus_worker = config["services"].get("plus-worker", {})
plus_web = config["services"].get("plus-web", {})

def environment(service):
    return service.get("environment", {})

print(
    web["environment"]["ARTFLOW_RELEASE_SHA"],
    proxy["environment"]["CADDY_SITE_ADDRESS"],
    web["image"],
    db["image"],
    proxy["image"],
    redis["image"],
    proxy["environment"].get("ARTFLOW_SITE_PROFILE", "v1"),
    plus_api.get("image", ""),
    plus_worker.get("image", ""),
    plus_web.get("image", ""),
    environment(plus_api).get("ARTFLOW_RELEASE_SHA", ""),
    environment(plus_worker).get("ARTFLOW_RELEASE_SHA", ""),
)
'
)
[[ "$rendered_profile" == "$site_profile" ]] || die 'rendered site profile does not match the selected deployment profile'
[[ "$release_sha" =~ ^[0-9a-fA-F]{40}$ ]] || die 'production build must use a full ARTFLOW_RELEASE_SHA'
python3 "$hostname_validator" "$site_address" \
    || die 'CADDY_SITE_ADDRESS must be a hostname without a scheme, port, or path'
is_release_image "$web_image" || die 'ARTFLOW_WEB_IMAGE must carry the deployed release SHA'
is_digest_image "$postgres_image" || die 'ARTFLOW_POSTGRES_IMAGE must use a verified digest'
is_digest_image "$caddy_image" || die 'ARTFLOW_CADDY_IMAGE must use a verified digest'
# Every image the manifest names must be digest-pinned, not just the two that happen to
# be validated above. `.env.production.example` states that rule for all of them, and a
# mutable tag that passes the gate makes the gate a description rather than a check.
is_digest_image "$redis_image" || die 'ARTFLOW_REDIS_IMAGE must use a verified digest'
web_revision="$(docker image inspect -f '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$web_image" 2>/dev/null)" \
    || die 'the prebuilt web image is not loaded locally'
[[ "$web_revision" == "$release_sha" ]] || die 'prebuilt web image revision does not match ARTFLOW_RELEASE_SHA'

if [[ "$site_profile" == "v2" ]]; then
    is_digest_image "$plus_api_image" || die 'ARTFLOW_PLUS_API_IMAGE must use a verified digest'
    is_digest_image "$plus_worker_image" || die 'ARTFLOW_PLUS_WORKER_IMAGE must use a verified digest'
    is_digest_image "$plus_web_image" || die 'ARTFLOW_PLUS_WEB_IMAGE must use a verified digest'
    [[ "$plus_api_release" == "$release_sha" ]] \
        || die 'plus-api ARTFLOW_RELEASE_SHA does not match the deployment SHA'
    [[ "$plus_worker_release" == "$release_sha" ]] \
        || die 'plus-worker ARTFLOW_RELEASE_SHA does not match the deployment SHA'
    for plus_image in "$plus_api_image" "$plus_worker_image" "$plus_web_image"; do
        plus_revision="$(docker image inspect -f '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$plus_image" 2>/dev/null)" \
            || die "Plus image is not loaded locally: $plus_image"
        [[ "$plus_revision" == "$release_sha" ]] \
            || die "Plus image revision does not match ARTFLOW_RELEASE_SHA: $plus_image"
    done
fi

"${compose[@]}" up --no-build --pull never --wait
"${compose[@]}" exec -T web python manage.py doctor --require-access-keys

health_url="https://$site_address/healthz/"
curl --fail --silent --show-error --max-time 20 "$health_url" >/dev/null
printf 'production deployment and external health check passed for %s\n' "$release_sha"
