#!/usr/bin/env bash
set -Eeuo pipefail

if (( $# == 0 )); then
    printf '%s\n' 'A command is required after docker-entrypoint.sh.' >&2
    exit 64
fi

if [[ "${DATABASE_ENGINE:-}" != "postgresql" ]]; then
    printf '%s\n' 'DATABASE_ENGINE must be postgresql in the container runtime.' >&2
    exit 64
fi

baked_release_sha=""
if [[ -r /app/ARTFLOW_RELEASE_SHA ]]; then
    baked_release_sha="$(tr -d '\r\n' < /app/ARTFLOW_RELEASE_SHA)"
fi
if [[ "${APP_ENV:-}" == "production" ]]; then
    configured_release_sha="${ARTFLOW_RELEASE_SHA:-}"
    if [[ ! "$configured_release_sha" =~ ^[0-9a-fA-F]{40}$ || -z "$baked_release_sha" || "$configured_release_sha" != "$baked_release_sha" ]]; then
        printf '%s\n' 'ARTFLOW_RELEASE_SHA must match the baked image revision.' >&2
        exit 64
    fi
fi

for required_variable in POSTGRES_DB POSTGRES_USER POSTGRES_PASSWORD POSTGRES_HOST POSTGRES_PORT; do
    if [[ -z "${!required_variable:-}" ]]; then
        printf 'Missing required database configuration: %s\n' "$required_variable" >&2
        exit 64
    fi
done

/app/scripts/wait-for-postgres.sh

process_role="${ARTFLOW_PROCESS_ROLE:-web}"
case "$process_role" in
    web)
        # The full system-check set is a startup gate. It used to sit on the 10 s
        # health probe; running it once here keeps the deployment gate without
        # paying for it on every heartbeat.
        python manage.py check
        python manage.py migrate --noinput
        python manage.py seed_ruleset_templates
        python manage.py collectstatic --noinput
        ;;
    realtime)
        # Realtime must never race the web container over migrations, seed data or
        # static collection. It only verifies that the Django configuration loads.
        python manage.py check
        ;;
    media)
        # The media pool exists so slow downloads cannot occupy the workers that answer
        # scoring, voting and judge requests. It serves the same controlled_media view
        # against the same database, so it must not race the web container either.
        python manage.py check
        ;;
    *)
        printf 'ARTFLOW_PROCESS_ROLE must be web, realtime or media, got: %s\n' "$process_role" >&2
        exit 64
        ;;
esac

exec "$@"
