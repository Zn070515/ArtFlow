#!/usr/bin/env bash
# One-time lab bootstrap: allow the login user to run sudo without a password so
# the deployment verification can be automated end to end. The rule is removed
# by disable-lab-sudo.sh when the lab is torn down.
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "enable-lab-sudo.sh must run as root" >&2
  exit 1
fi

USER_NAME="${1:-xuxin}"
FILE="/etc/sudoers.d/90-artflow-lab"

cat >"${FILE}" <<EOF
# ArtFlow Kubernetes lab: temporary passwordless sudo for automated bootstrap.
# Remove with deploy/k8s/bootstrap/disable-lab-sudo.sh.
${USER_NAME} ALL=(ALL) NOPASSWD: ALL
EOF

chmod 0440 "${FILE}"
visudo -cf "${FILE}"
echo "enabled passwordless sudo for ${USER_NAME} on $(hostname)"
