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

for required_variable in POSTGRES_DB POSTGRES_USER POSTGRES_PASSWORD POSTGRES_HOST POSTGRES_PORT; do
    if [[ -z "${!required_variable:-}" ]]; then
        printf 'Missing required database configuration: %s\n' "$required_variable" >&2
        exit 64
    fi
done

/app/scripts/wait-for-postgres.sh
python manage.py migrate --noinput
python manage.py collectstatic --noinput

exec "$@"
