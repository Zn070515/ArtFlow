#!/usr/bin/env bash
set -Eeuo pipefail

die() {
    printf 'offsite backup: %s\n' "$1" >&2
    exit 64
}

if (( $# != 1 )); then
    die 'usage: offsite_backup.sh BACKUP_SET'
fi

backup_set="$(cd -- "$1" && pwd -P)" || die 'backup set does not exist'
bucket="${ARTFLOW_OFFSITE_BUCKET:-}"
prefix="${ARTFLOW_OFFSITE_PREFIX:-}"
tool="${ARTFLOW_OFFSITE_TOOL:-ossutil}"

[[ -n "$bucket" && "$bucket" =~ ^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$ ]] \
    || die 'ARTFLOW_OFFSITE_BUCKET must be a valid OSS bucket name'
prefix="${prefix#/}"
prefix="${prefix%/}"
[[ "$prefix" != *..* && "$prefix" != *\\* ]] \
    || die 'ARTFLOW_OFFSITE_PREFIX contains an unsafe path segment'

for required in manifest.json database.dump media.tar.gz; do
    [[ -f "$backup_set/$required" ]] || die "backup set is missing $required"
done

command -v "$tool" >/dev/null 2>&1 || die "off-site tool not found: $tool"
command -v python3 >/dev/null 2>&1 || die 'python3 is required to read the manifest'
command -v sha256sum >/dev/null 2>&1 || die 'sha256sum is required to verify the backup'

read -r expected_database expected_media < <(
    python3 - "$backup_set/manifest.json" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as manifest_file:
    manifest = json.load(manifest_file)
print(manifest.get("database_sha256", ""), manifest.get("media_sha256", ""))
PY
)

[[ "$expected_database" =~ ^[0-9a-fA-F]{64}$ ]] || die 'manifest database_sha256 is invalid'
[[ "$expected_media" =~ ^[0-9a-fA-F]{64}$ ]] || die 'manifest media_sha256 is invalid'
actual_database="$(sha256sum "$backup_set/database.dump" | awk '{print $1}')"
actual_media="$(sha256sum "$backup_set/media.tar.gz" | awk '{print $1}')"
[[ "$actual_database" == "${expected_database,,}" ]] || die 'database_sha256 does not match'
[[ "$actual_media" == "${expected_media,,}" ]] || die 'media_sha256 does not match'

leaf="$(basename -- "$backup_set")"
destination="oss://$bucket"
[[ -n "$prefix" ]] && destination+="/$prefix"
destination+="/$leaf"

"$tool" cp -r "$backup_set" "$destination"
"$tool" stat "$destination/manifest.json" >/dev/null
printf '%s\n' "$destination"
