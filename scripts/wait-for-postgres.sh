#!/usr/bin/env bash
set -Eeuo pipefail

if (( $# != 0 )); then
    printf '%s\n' 'wait-for-postgres.sh does not accept positional arguments.' >&2
    exit 64
fi

max_attempts="${POSTGRES_WAIT_ATTEMPTS:-30}"
wait_interval_seconds="${POSTGRES_WAIT_INTERVAL_SECONDS:-1}"

if ! [[ "$max_attempts" =~ ^[1-9][0-9]?$ ]] || (( max_attempts > 60 )); then
    printf '%s\n' 'POSTGRES_WAIT_ATTEMPTS must be an integer between 1 and 60.' >&2
    exit 64
fi

if ! [[ "$wait_interval_seconds" =~ ^[1-9][0-9]?$ ]] || (( wait_interval_seconds > 30 )); then
    printf '%s\n' 'POSTGRES_WAIT_INTERVAL_SECONDS must be an integer between 1 and 30.' >&2
    exit 64
fi

for required_variable in POSTGRES_DB POSTGRES_USER POSTGRES_HOST POSTGRES_PORT; do
    if [[ -z "${!required_variable:-}" ]]; then
        printf 'Missing required database configuration: %s\n' "$required_variable" >&2
        exit 64
    fi
done

if ! [[ "$POSTGRES_PORT" =~ ^[0-9]+$ ]] || (( POSTGRES_PORT < 1 || POSTGRES_PORT > 65535 )); then
    printf '%s\n' 'POSTGRES_PORT must be an integer between 1 and 65535.' >&2
    exit 64
fi

for (( attempt = 1; attempt <= max_attempts; attempt++ )); do
    if PGCONNECT_TIMEOUT=3 pg_isready --quiet --host="$POSTGRES_HOST" --port="$POSTGRES_PORT" --username="$POSTGRES_USER" --dbname="$POSTGRES_DB"; then
        printf '%s\n' 'PostgreSQL is ready.'
        exit 0
    fi

    printf 'Waiting for PostgreSQL (%d/%d)...\n' "$attempt" "$max_attempts" >&2
    sleep "$wait_interval_seconds"
done

printf 'PostgreSQL did not become ready after %d attempts.\n' "$max_attempts" >&2
exit 1
