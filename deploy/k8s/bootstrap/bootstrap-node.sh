#!/usr/bin/env bash
# Per-node lab bootstrap: allow containerd to pull from the in-cluster registry.
set -euo pipefail

REGISTRY_HOST="${REGISTRY_HOST:-192.168.47.10:5000}"
REGISTRY_HTTP="http://${REGISTRY_HOST}"
CERTS_DIR="/etc/containerd/certs.d/${REGISTRY_HOST}"
CONFIG="/etc/containerd/config.toml"

if [[ "${EUID}" -ne 0 ]]; then
  echo "bootstrap-node.sh must run as root" >&2
  exit 1
fi

install -d -m 0755 "${CERTS_DIR}"
cat >"${CERTS_DIR}/hosts.toml" <<EOF
server = "${REGISTRY_HTTP}"

[host."${REGISTRY_HTTP}"]
  capabilities = ["pull", "resolve"]
EOF

changed=0
if ! grep -q "config_path = '/etc/containerd/certs.d'" "${CONFIG}"; then
  cp "${CONFIG}" "${CONFIG}.bak.$(date +%s)"
  python3 - "${CONFIG}" <<'PY'
import sys
from pathlib import Path

path = Path(sys.argv[1])
text = path.read_text()
needle = "[plugins.'io.containerd.cri.v1.images'.registry]"
if needle not in text:
    raise SystemExit("registry section not found; inspect /etc/containerd/config.toml")
text = text.replace(needle, needle + "\n  config_path = '/etc/containerd/certs.d'", 1)
path.write_text(text)
PY
  changed=1
fi

if [[ "${changed}" -eq 1 ]]; then
  systemctl restart containerd
fi
systemctl is-active containerd
echo "node bootstrap complete on $(hostname): ${REGISTRY_HOST}"
