#!/usr/bin/env bash
# Remove the temporary passwordless sudo rule installed by enable-lab-sudo.sh.
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "disable-lab-sudo.sh must run as root" >&2
  exit 1
fi

rm -f /etc/sudoers.d/90-artflow-lab
visudo -cf /etc/sudoers >/dev/null
echo "removed the ArtFlow lab sudo rule on $(hostname)"
