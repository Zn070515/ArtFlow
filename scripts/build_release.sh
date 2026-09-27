#!/usr/bin/env bash
set -Eeuo pipefail

die() {
    printf 'release build: %s\n' "$1" >&2
    exit 64
}

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
output_root="${1:-$repository_root/release-artifacts}"
python_image="${ARTFLOW_PYTHON_IMAGE:-}"

command -v git >/dev/null 2>&1 || die 'git is required'
command -v docker >/dev/null 2>&1 || die 'docker is required'
command -v python3 >/dev/null 2>&1 || die 'python3 is required'
[[ "$python_image" =~ ^[^[:space:]@]+@sha256:[0-9a-fA-F]{64}$ ]] \
    || die 'ARTFLOW_PYTHON_IMAGE must be a verified digest-pinned image'

git -C "$repository_root" diff --quiet || die 'working tree has unstaged changes'
git -C "$repository_root" diff --cached --quiet || die 'index has staged changes'
release_sha="$(git -C "$repository_root" rev-parse HEAD)"
[[ "$release_sha" =~ ^[0-9a-fA-F]{40}$ ]] || die 'could not resolve a full release SHA'
image_ref="artflow-web:$release_sha"
mkdir -p -- "$output_root"

docker build --pull=false \
    --build-arg "ARTFLOW_PYTHON_IMAGE=$python_image" \
    --build-arg "ARTFLOW_BUILD_SHA=$release_sha" \
    --tag "$image_ref" "$repository_root"
image_id="$(docker image inspect -f '{{.Id}}' "$image_ref")"
image_revision="$(docker image inspect -f '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$image_ref")"
[[ "$image_revision" == "$release_sha" ]] || die 'built image revision does not match the source SHA'
docker save --output "$output_root/artflow-web-$release_sha.tar" "$image_ref"

python3 - "$output_root/release-manifest.json" "$release_sha" "$image_ref" "$image_id" "$python_image" <<'PY'
import json
import sys
from pathlib import Path

output, release_sha, image_ref, image_id, python_image = sys.argv[1:]
Path(output).write_text(
    json.dumps(
        {
            "git_sha": release_sha,
            "web_image": image_ref,
            "web_image_id": image_id,
            "python_base_image": python_image,
        },
        indent=2,
    )
    + "\n",
    encoding="utf-8",
)
PY
printf 'release image: %s\nartifact: %s\n' "$image_ref" "$output_root/artflow-web-$release_sha.tar"
