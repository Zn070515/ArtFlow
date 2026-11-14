# ArtFlow-Plus Kubernetes Deployment Verification — Implementation Plan

> **For agentic workers:** Execute inline in this session. The repository rule in
> `AGENTS.md` forbids spawning subagents or delegating inspection, editing,
> testing, verification, cleanup, commits, or merges. Steps use checkbox
> (`- [ ]`) syntax for tracking.

**Goal:** Prove the ArtFlow-Plus release images deploy, roll, heal, and recover
correctly on the lab Kubernetes cluster, and record the evidence.

**Architecture:** Kustomize manifests under `deploy/k8s` run the same four
workloads as Compose (`plus-db`, `plus-api`, `plus-worker`, `plus-web`) plus a
Caddy proxy with an internal CA. The database and API are pinned to separate
worker nodes so local-path RWO volumes and a zero-downtime rollout can coexist
in the lab. Application images are built locally from a clean tree and pushed to
an in-cluster registry.

**Tech Stack:** Kubernetes v1.36.5, Cilium, kustomize (built into kubectl),
PowerShell 7, Docker Desktop, PostgreSQL 18, Caddy 2.

**Spec:** [2026-11-10-k8s-deployment-verification-design.md](../specs/2026-11-10-k8s-deployment-verification-design.md)

---

## File Structure

| Path | Responsibility |
|---|---|
| `deploy/k8s/bootstrap/bootstrap-node.sh` | One-time root work on each node: containerd insecure-registry config, local-path, metrics-server |
| `deploy/k8s/bootstrap/registry.yaml` | In-cluster registry Deployment, Service, PVC |
| `deploy/k8s/bootstrap/rbac.yaml` | `artflow-system` namespace, deployer ServiceAccount, namespace-scoped RoleBindings |
| `deploy/k8s/base/` | Shared manifests: config, db, api, worker, web, proxy, services, network policies |
| `deploy/k8s/overlays/dev/` | Long-lived namespace, pinned digests, placement |
| `deploy/k8s/overlays/test/` | Disposable namespace, pinned digests, placement |
| `deploy/k8s/overlays/restore/` | Restore namespace used by T5 |
| `scripts/k8s/lib.ps1` | Shared PowerShell helpers (kubectl wrapper, waits, evidence) |
| `scripts/k8s/build-images.ps1` | Clean-tree guard, build, push, digest record |
| `scripts/k8s/deploy.ps1` | Generate secrets, apply an overlay, wait for readiness |
| `scripts/k8s/reset.ps1` | Delete namespaced resources and reapply |
| `scripts/k8s/test-matrix.ps1` | T0–T10 scenarios |
| `scripts/k8s/teardown.ps1` | Remove application resources, keep bootstrap |
| `docs/artflow-plus/k8s-deployment-test.md` | Operator runbook |
| `docs/artflow-plus/checks/2026-11-10-k8s-deployment-checks.md` | Evidence log |
| `tests/gates/test_release_artifacts.py` | Updated gate for the nginx template |
| `deploy/plus/nginx.conf.template` | Replaces `deploy/plus/nginx.conf` |
| `deploy/plus/Dockerfile` | Web stage copies the template |
| `deploy/compose.production.yml` | Adds `ARTFLOW_NGINX_RESOLVER` to `plus-web` |
| `.env.production.example` | Documents the resolver variable |

---

## Phase 0 — Bootstrap (one root session through the VMware console)

### Task 0: Create the working branch

- [ ] **Step 1: Branch from a clean main**

```powershell
Set-Location C:\Users\16275\Desktop\ArtFlow
git status --short --branch
git switch main
git pull --ff-only origin main
git switch -c build/k8s-deployment-verification
```

Expected: a clean tree on `main`, then a new branch. Every commit in this plan
lands on `build/k8s-deployment-verification`; Task 28 merges it with `--no-ff`.

### Task 1: Bootstrap script and cluster prerequisites

**Files:**
- Create: `deploy/k8s/bootstrap/bootstrap-node.sh`
- Create: `deploy/k8s/bootstrap/registry.yaml`
- Create: `deploy/k8s/bootstrap/rbac.yaml`
- Create: `deploy/k8s/bootstrap/namespaces.yaml`

- [ ] **Step 1: Create the namespace and RBAC manifest**

`deploy/k8s/bootstrap/namespaces.yaml`:

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: artflow-system
---
apiVersion: v1
kind: Namespace
metadata:
  name: artflow-dev
---
apiVersion: v1
kind: Namespace
metadata:
  name: artflow-test
---
apiVersion: v1
kind: Namespace
metadata:
  name: artflow-restore
```

`deploy/k8s/bootstrap/rbac.yaml`:

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: artflow-deployer
  namespace: artflow-system
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: artflow-deployer-edit
  namespace: artflow-dev
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: edit
subjects:
  - kind: ServiceAccount
    name: artflow-deployer
    namespace: artflow-system
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: artflow-deployer-edit
  namespace: artflow-test
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: edit
subjects:
  - kind: ServiceAccount
    name: artflow-deployer
    namespace: artflow-system
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: artflow-deployer-edit
  namespace: artflow-restore
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: edit
subjects:
  - kind: ServiceAccount
    name: artflow-deployer
    namespace: artflow-system
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: artflow-metrics-reader
rules:
  - apiGroups: ["metrics.k8s.io"]
    resources: ["pods", "nodes"]
    verbs: ["get", "list"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: artflow-deployer-metrics
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: artflow-metrics-reader
subjects:
  - kind: ServiceAccount
    name: artflow-deployer
    namespace: artflow-system
```

- [ ] **Step 2: Create the in-cluster registry manifest**

`deploy/k8s/bootstrap/registry.yaml`:

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: artflow-registry-data
  namespace: artflow-system
spec:
  accessModes: ["ReadWriteOnce"]
  resources:
    requests:
      storage: 5Gi
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: artflow-registry
  namespace: artflow-system
spec:
  replicas: 1
  selector:
    matchLabels:
      app: artflow-registry
  template:
    metadata:
      labels:
        app: artflow-registry
    spec:
      nodeSelector:
        kubernetes.io/hostname: k8s-control
      tolerations:
        - key: node-role.kubernetes.io/control-plane
          operator: Exists
          effect: NoSchedule
      containers:
        - name: registry
          image: docker.m.daocloud.io/library/registry:2
          ports:
            - name: http
              containerPort: 5000
              hostPort: 5000
          env:
            - name: REGISTRY_STORAGE_DELETE_ENABLED
              value: "true"
          volumeMounts:
            - name: data
              mountPath: /var/lib/registry
          readinessProbe:
            httpGet:
              path: /v2/
              port: http
            periodSeconds: 5
          resources:
            requests:
              cpu: 50m
              memory: 64Mi
            limits:
              cpu: 500m
              memory: 256Mi
      volumes:
        - name: data
          persistentVolumeClaim:
            claimName: artflow-registry-data
---
apiVersion: v1
kind: Service
metadata:
  name: artflow-registry
  namespace: artflow-system
spec:
  selector:
    app: artflow-registry
  ports:
    - name: http
      port: 5000
      targetPort: 5000
```

- [ ] **Step 3: Create the per-node bootstrap script**

`deploy/k8s/bootstrap/bootstrap-node.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

REGISTRY_HOST="${REGISTRY_HOST:-192.168.47.10:5000}"
REGISTRY_HTTP="http://${REGISTRY_HOST}"
CERTS_DIR="/etc/containerd/certs.d/${REGISTRY_HOST}"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "run as root" >&2
  exit 1
fi

install -d -m 0755 "${CERTS_DIR}"
cat >"${CERTS_DIR}/hosts.toml" <<EOF
server = "${REGISTRY_HTTP}"

[host."${REGISTRY_HTTP}"]
  capabilities = ["pull", "resolve"]
EOF

if ! grep -q "config_path = '/etc/containerd/certs.d'" /etc/containerd/config.toml; then
  cp /etc/containerd/config.toml "/etc/containerd/config.toml.bak.$(date +%s)"
  python3 - <<'PY'
from pathlib import Path
path = Path("/etc/containerd/config.toml")
text = path.read_text()
needle = "[plugins.'io.containerd.cri.v1.images'.registry]"
if needle not in text:
    raise SystemExit("registry section not found; inspect /etc/containerd/config.toml")
text = text.replace(needle, needle + "\n  config_path = '/etc/containerd/certs.d'", 1)
path.write_text(text)
PY
fi

systemctl restart containerd
systemctl is-active containerd
echo "node bootstrap complete: ${REGISTRY_HOST}"
```

- [ ] **Step 4: Copy the bootstrap assets to the control node**

From the Windows workstation:

```powershell
ssh k8s-control "mkdir -p /home/xuxin/artflow-bootstrap"
scp -r deploy/k8s/bootstrap/. k8s-control:/home/xuxin/artflow-bootstrap/
```

- [ ] **Step 5: Run the bootstrap on all three nodes (user-assisted)**

In the `k8s-control` VMware console as `xuxin`, copy the script to each worker
and run it with `sudo` (the console prompts for the password):

```bash
scp /home/xuxin/artflow-bootstrap/bootstrap-node.sh k8s-worker-1:/tmp/
scp /home/xuxin/artflow-bootstrap/bootstrap-node.sh k8s-worker-2:/tmp/
sudo bash /home/xuxin/artflow-bootstrap/bootstrap-node.sh
ssh -t k8s-worker-1 'sudo bash /tmp/bootstrap-node.sh'
ssh -t k8s-worker-2 'sudo bash /tmp/bootstrap-node.sh'
```

Expected: each node prints `node bootstrap complete: 192.168.47.10:5000` and
`active`.

- [ ] **Step 6: Install namespaces, RBAC, local-path, metrics-server, registry**

On `k8s-control` as root (console):

```bash
kubectl apply -f /home/xuxin/artflow-bootstrap/namespaces.yaml
kubectl apply -f /home/xuxin/artflow-bootstrap/rbac.yaml
kubectl apply -f https://raw.githubusercontent.com/rancher/local-path-provisioner/v0.0.31/deploy/local-path-storage.yaml
kubectl -n local-path-storage rollout status deploy/local-path-provisioner --timeout=180s
kubectl patch storageclass local-path -p '{"metadata":{"annotations":{"storageclass.kubernetes.io/is-default-class":"true"}}}'
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/download/v0.7.2/components.yaml
kubectl -n kube-system patch deployment metrics-server --type=json \
  -p='[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]'
kubectl -n kube-system rollout status deploy/metrics-server --timeout=180s
kubectl apply -f /home/xuxin/artflow-bootstrap/registry.yaml
kubectl -n artflow-system rollout status deploy/artflow-registry --timeout=180s
```

If a GitHub URL is unreachable, fetch the same pinned version through
`https://gh-proxy.com/https://raw.githubusercontent.com/...` and record which
mirror was used.

- [ ] **Step 7: Create the deployer kubeconfig**

On `k8s-control` as root:

```bash
TOKEN="$(kubectl -n artflow-system create token artflow-deployer --duration=8760h)"
CA="$(kubectl config view --raw -o jsonpath='{.clusters[0].cluster.certificate-authority-data}')"
SERVER="$(kubectl config view --raw -o jsonpath='{.clusters[0].cluster.server}')"
cat > /home/xuxin/artflow-lab.kubeconfig <<EOF
apiVersion: v1
kind: Config
clusters:
  - name: artflow-lab
    cluster:
      server: ${SERVER}
      certificate-authority-data: ${CA}
users:
  - name: artflow-deployer
    user:
      token: ${TOKEN}
contexts:
  - name: artflow-lab
    context:
      cluster: artflow-lab
      user: artflow-deployer
      namespace: artflow-dev
current-context: artflow-lab
EOF
chown xuxin:xuxin /home/xuxin/artflow-lab.kubeconfig
chmod 600 /home/xuxin/artflow-lab.kubeconfig
```

Copy it to the workstation:

```powershell
scp k8s-control:/home/xuxin/artflow-lab.kubeconfig C:\Users\16275\Desktop\ArtFlow\.kube\artflow-lab.yaml
```

- [ ] **Step 8: Verify least privilege from the workstation**

```powershell
kubectl --kubeconfig .kube/artflow-lab.yaml auth can-i create deployment -n artflow-dev
kubectl --kubeconfig .kube/artflow-lab.yaml auth can-i create namespace
```

Expected: first `yes`, second `no`.

- [ ] **Step 9: Commit**

```bash
git add deploy/k8s/bootstrap
git commit -m "build: add the Kubernetes lab bootstrap"
```

---

### Task 2: Base images and digest record

**Files:**
- Create: `deploy/k8s/overlays/dev/images.env`
- Create: `deploy/k8s/overlays/test/images.env`
- Modify: `.gitignore`

- [ ] **Step 1: Add `.kube/` and local secret files to `.gitignore`**

Append to `.gitignore`:

```gitignore
# Kubernetes lab credentials and generated manifests
.kube/
deploy/k8s/overlays/*/secrets.env
```

- [ ] **Step 2: Push base images through the local registry**

```powershell
$registry = "192.168.47.10:5000"
docker pull docker.m.daocloud.io/library/postgres:18
docker pull docker.m.daocloud.io/library/caddy:2-alpine
docker pull docker.m.daocloud.io/library/busybox:1.36
docker tag docker.m.daocloud.io/library/postgres:18 "$registry/library/postgres:18"
docker tag docker.m.daocloud.io/library/caddy:2-alpine "$registry/library/caddy:2-alpine"
docker tag docker.m.daocloud.io/library/busybox:1.36 "$registry/library/busybox:1.36"
docker push "$registry/library/postgres:18"
docker push "$registry/library/caddy:2-alpine"
docker push "$registry/library/busybox:1.36"
```

Record each digest:

```powershell
foreach ($name in @("postgres:18", "caddy:2-alpine", "busybox:1.36")) {
  docker inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$registry/library/$name" |
    Select-String -Pattern "^192\.168\.47\.10:5000/" |
    ForEach-Object { $_.Line }
}
```

Use the line that starts with `192.168.47.10:5000/`; the DaoCloud digest also
appears in `RepoDigests` and must not be used.

Create the overlay directories and write the three digests into
`deploy/k8s/overlays/dev/images.env` and `deploy/k8s/overlays/test/images.env`:

```powershell
New-Item -ItemType Directory -Force -Path deploy/k8s/overlays/dev, deploy/k8s/overlays/test | Out-Null
```

The files contain:

```text
POSTGRES_DIGEST=sha256:<digest>
CADDY_DIGEST=sha256:<digest>
BUSYBOX_DIGEST=sha256:<digest>
```

These files are tracked because they contain no credentials.

- [ ] **Step 3: Verify a node can pull from the registry**

```powershell
ssh k8s-worker-1 "curl -s -o /dev/null -w '%{http_code}\n' http://192.168.47.10:5000/v2/"
```

Expected: `200`.

- [ ] **Step 4: Commit**

```bash
git add .gitignore deploy/k8s/overlays/dev/images.env deploy/k8s/overlays/test/images.env
git commit -m "build: record the lab base image digests"
```

---

## Phase 1 — Artifact fix F1

### Task 3: Update the release-artifact gate first

**Files:**
- Modify: `tests/gates/test_release_artifacts.py:120-126`

- [ ] **Step 1: Change the gate to expect the template**

Replace `test_plus_proxy_trust_and_body_limits_are_explicit` with:

```python
def test_plus_proxy_trust_and_body_limits_are_explicit() -> None:
    compose_text = COMPOSE.read_text(encoding="utf-8")
    assert "ARTFLOW_PLUS_TRUST_PROXY" in compose_text
    nginx_template = (ROOT / "deploy" / "plus" / "nginx.conf.template").read_text(encoding="utf-8")
    caddy = (ROOT / "deploy" / "caddy" / "sites" / "v2.caddy").read_text(encoding="utf-8")
    assert "resolver ${ARTFLOW_NGINX_RESOLVER}" in nginx_template
    assert "client_max_body_size 128m" in nginx_template
    assert "max_size 128MB" in caddy


def test_plus_web_image_reads_the_resolver_from_the_environment() -> None:
    dockerfile = (ROOT / "deploy" / "plus" / "Dockerfile").read_text(encoding="utf-8")
    assert "/etc/nginx/templates/default.conf.template" in dockerfile
    assert "deploy/plus/nginx.conf.template" in dockerfile
    compose = _yaml(COMPOSE)["services"]["plus-web"]
    assert compose["environment"]["ARTFLOW_NGINX_RESOLVER"] == "${ARTFLOW_NGINX_RESOLVER:-127.0.0.11}"
```

- [ ] **Step 2: Run the gate to verify it fails**

```powershell
uv run pytest tests/gates/test_release_artifacts.py -q
```

Expected: FAIL with `FileNotFoundError` for `deploy/plus/nginx.conf.template`.

- [ ] **Step 3: Commit the failing gate**

```bash
git add tests/gates/test_release_artifacts.py
git commit -m "test: require a portable nginx resolver template"
```

---

### Task 4: Implement the nginx template

**Files:**
- Create: `deploy/plus/nginx.conf.template`
- Delete: `deploy/plus/nginx.conf`
- Modify: `deploy/plus/Dockerfile:46-52`
- Modify: `deploy/compose.production.yml:79-92`
- Modify: `.env.production.example`

- [ ] **Step 1: Create the template**

Rename the file and change only the resolver line:

```bash
git mv deploy/plus/nginx.conf deploy/plus/nginx.conf.template
```

Edit `deploy/plus/nginx.conf.template`:

```nginx
server {
  listen 8080;
  server_name _;

  root /usr/share/nginx/html;
  index index.html;
  client_max_body_size 128m;

  # Docker Compose supplies 127.0.0.11; Kubernetes supplies its cluster DNS.
  resolver ${ARTFLOW_NGINX_RESOLVER} valid=10s ipv6=off;
  set $plus_api plus-api:3000;

  # Caddy's health probe uses /healthz/; Fastify only registers the bare paths.
  location ~ ^/(healthz|readyz)/?$ {
    proxy_pass http://$plus_api/$1;
    proxy_set_header Host $host;
  }

  location /api/ {
    proxy_pass http://$plus_api;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $http_x_forwarded_proto;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 3600s;
  }

  location / {
    try_files $uri $uri/ /index.html;
  }

  add_header X-Content-Type-Options nosniff always;
  add_header Referrer-Policy strict-origin-when-cross-origin always;
}
```

- [ ] **Step 2: Update the Dockerfile web stage**

Replace the web stage's config copy:

```dockerfile
FROM ${NGINX_IMAGE} AS web
ARG ARTFLOW_BUILD_SHA
LABEL org.opencontainers.image.revision="${ARTFLOW_BUILD_SHA}"
COPY deploy/plus/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /src/apps/web/dist /usr/share/nginx/html
COPY --from=build /src/ARTFLOW_RELEASE_SHA /usr/share/nginx/html/ARTFLOW_RELEASE_SHA
EXPOSE 8080
```

- [ ] **Step 3: Add the resolver to the Compose web service**

In `deploy/compose.production.yml`, add an `environment` block to `plus-web`:

```yaml
  plus-web:
    image: ${ARTFLOW_PLUS_WEB_IMAGE:?Set ARTFLOW_PLUS_WEB_IMAGE}
    restart: unless-stopped
    environment:
      ARTFLOW_NGINX_RESOLVER: ${ARTFLOW_NGINX_RESOLVER:-127.0.0.11}
    depends_on:
      plus-api:
        condition: service_healthy
```

- [ ] **Step 4: Document the variable**

Append to `.env.production.example`:

```dotenv
# DNS resolver used by the web image's /api proxy. Compose keeps the Docker
# embedded resolver; Kubernetes overrides it with the cluster DNS address.
ARTFLOW_NGINX_RESOLVER=127.0.0.11
```

- [ ] **Step 5: Run the focused gates**

```powershell
uv run pytest tests/gates/test_release_artifacts.py -q
pnpm -C plus run check
pnpm -C plus run build:prod
pwsh -NoProfile -File scripts/check_docs.ps1
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add deploy/plus/nginx.conf.template deploy/plus/nginx.conf deploy/plus/Dockerfile deploy/compose.production.yml .env.production.example
git commit -m "build: make the web proxy resolver environment-portable"
```

---

### Task 5: Build and push the application images

**Files:**
- Create: `scripts/k8s/build-images.ps1`

- [ ] **Step 1: Write the build script**

`scripts/k8s/build-images.ps1`:

```powershell
[CmdletBinding()]
param(
  [string]$Registry = "192.168.47.10:5000",
  [string]$Output = "deploy/k8s/overlays/dev/images.env"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
Set-Location $root

$dirty = git status --porcelain
if ($dirty) {
  throw "Refusing to build from a dirty tree:`n$dirty"
}

$sha = (git rev-parse HEAD).Trim()
if ($sha -notmatch '^[0-9a-f]{40}$') {
  throw "HEAD is not a 40-character SHA: $sha"
}

$targets = @("api", "worker", "web")
$digests = @{}
foreach ($target in $targets) {
  $tag = "$Registry/artflow-plus-$target`:$sha"
  docker build --platform linux/amd64 `
    --build-arg "ARTFLOW_BUILD_SHA=$sha" `
    -f deploy/plus/Dockerfile --target $target -t $tag .
  if ($LASTEXITCODE -ne 0) { throw "docker build failed for $target" }
  docker push $tag
  if ($LASTEXITCODE -ne 0) { throw "docker push failed for $target" }
  $repoDigest = docker inspect --format '{{index .RepoDigests 0}}' $tag
  $digests[$target] = ($repoDigest -split '@')[1]
}

$lines = @("RELEASE_SHA=$sha")
foreach ($target in $targets) {
  $name = "ARTFLOW_PLUS_" + $target.ToUpperInvariant() + "_DIGEST"
  $lines += "$name=$($digests[$target])"
}
$merged = $lines + (Get-Content -LiteralPath $Output -ErrorAction SilentlyContinue)
$merged | Select-Object -Unique | Set-Content -LiteralPath $Output -Encoding utf8

$base = Get-Content -LiteralPath $Output | ConvertFrom-StringData
foreach ($overlay in @("dev", "test", "restore")) {
  $path = "deploy/k8s/overlays/$overlay/kustomization.yaml"
  if (-not (Test-Path -LiteralPath $path)) { continue }
  $text = Get-Content -LiteralPath $path -Raw
  $text = $text.Replace("sha256:REPLACE_WITH_API_DIGEST", $digests["api"])
  $text = $text.Replace("sha256:REPLACE_WITH_WORKER_DIGEST", $digests["worker"])
  $text = $text.Replace("sha256:REPLACE_WITH_WEB_DIGEST", $digests["web"])
  $text = $text.Replace("sha256:REPLACE_WITH_POSTGRES_DIGEST", $base.POSTGRES_DIGEST)
  $text = $text.Replace("sha256:REPLACE_WITH_CADDY_DIGEST", $base.CADDY_DIGEST)
  $text = $text.Replace("sha256:REPLACE_WITH_BUSYBOX_DIGEST", $base.BUSYBOX_DIGEST)
  Set-Content -LiteralPath $path -Value $text -NoNewline
}

Get-Content -LiteralPath $Output
```

- [ ] **Step 2: Do not run the script yet**

The script rewrites the digests in `deploy/k8s/overlays/*/kustomization.yaml`.
Those files are created in Task 14, so the first run happens there. Running it
now would silently skip the overlay rewrite.

- [ ] **Step 3: Commit**

```bash
git add scripts/k8s/build-images.ps1
git commit -m "build: add the lab image build and push script"
```

---

## Phase 2 — Manifests

### Task 6: Base kustomization, config, and Secret template

**Files:**
- Create: `deploy/k8s/base/kustomization.yaml`
- Create: `deploy/k8s/base/config.yaml`
- Create: `deploy/k8s/base/secrets.env.example`

- [ ] **Step 1: Create the ConfigMap**

`deploy/k8s/base/config.yaml`:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: plus-config
data:
  NODE_ENV: production
  APP_ENV: production
  HOST: 0.0.0.0
  PORT: "3000"
  ARTFLOW_PLUS_INLINE_RELAY: "0"
  ARTFLOW_PLUS_ARCHIVE_DIR: /app/var/archives
  ARTFLOW_PLUS_MEDIA_DIR: /app/var/media
  ARTFLOW_PLUS_WORKER_RELAY_INTERVAL_MS: "250"
  ARTFLOW_PLUS_WORKER_SHUTDOWN_TIMEOUT_MS: "10000"
  ARTFLOW_PLUS_WORKER_READY_FILE: /tmp/artflow-worker-ready
  ARTFLOW_NGINX_RESOLVER: 10.96.0.10
  ARTFLOW_PLUS_TRUST_PROXY: 10.244.0.0/16
```

- [ ] **Step 2: Create the Secret template**

`deploy/k8s/base/secrets.env.example`:

```dotenv
POSTGRES_USER=artflow_plus
POSTGRES_DB=artflow_plus
POSTGRES_PASSWORD=replace-with-a-strong-password
ARTFLOW_PLUS_DATABASE_URL=postgresql://artflow_plus:replace-with-a-strong-password@plus-db:5432/artflow_plus
ARTFLOW_PLUS_CREDENTIAL_SECRET=replace-with-32-or-more-random-bytes
ARTFLOW_RELEASE_SHA=replace-with-the-40-character-build-sha
```

- [ ] **Step 3: Create the file PVCs**

`deploy/k8s/base/pvcs.yaml`:

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: plus-media
spec:
  accessModes: ["ReadWriteOnce"]
  resources:
    requests:
      storage: 1Gi
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: plus-archives
spec:
  accessModes: ["ReadWriteOnce"]
  resources:
    requests:
      storage: 1Gi
```

- [ ] **Step 4: Create the base kustomization**

`deploy/k8s/base/kustomization.yaml`:

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - config.yaml
  - pvcs.yaml
  - db.yaml
  - api.yaml
  - worker.yaml
  - web.yaml
  - proxy.yaml
  - services.yaml
  - networkpolicies.yaml
```

- [ ] **Step 5: Commit**

```bash
git add deploy/k8s/base
git commit -m "build: add the Kubernetes base configuration"
```

---

### Task 7: Database StatefulSet

**Files:**
- Create: `deploy/k8s/base/db.yaml`

- [ ] **Step 1: Write the StatefulSet**

`deploy/k8s/base/db.yaml`:

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: plus-db
spec:
  serviceName: plus-db
  replicas: 1
  selector:
    matchLabels:
      app: plus-db
  template:
    metadata:
      labels:
        app: plus-db
    spec:
      terminationGracePeriodSeconds: 60
      containers:
        - name: postgres
          image: library/postgres
          ports:
            - name: postgres
              containerPort: 5432
          env:
            - name: POSTGRES_USER
              valueFrom:
                secretKeyRef:
                  name: plus-secrets
                  key: POSTGRES_USER
            - name: POSTGRES_DB
              valueFrom:
                secretKeyRef:
                  name: plus-secrets
                  key: POSTGRES_DB
            - name: POSTGRES_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: plus-secrets
                  key: POSTGRES_PASSWORD
          volumeMounts:
            - name: data
              mountPath: /var/lib/postgresql
          readinessProbe:
            exec:
              command: ["sh", "-c", "pg_isready -U \"$POSTGRES_USER\" -d \"$POSTGRES_DB\""]
            periodSeconds: 5
            failureThreshold: 3
          livenessProbe:
            exec:
              command: ["sh", "-c", "pg_isready -U \"$POSTGRES_USER\" -d \"$POSTGRES_DB\""]
            periodSeconds: 10
            failureThreshold: 3
          resources:
            requests:
              cpu: 250m
              memory: 512Mi
            limits:
              cpu: "1"
              memory: 1Gi
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: ["ReadWriteOnce"]
        resources:
          requests:
            storage: 1Gi
```

- [ ] **Step 2: Commit**

```bash
git add deploy/k8s/base/db.yaml
git commit -m "build: add the Kubernetes database StatefulSet"
```

---

### Task 8: API Deployment

**Files:**
- Create: `deploy/k8s/base/api.yaml`

- [ ] **Step 1: Write the Deployment**

`deploy/k8s/base/api.yaml`:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: plus-api
spec:
  replicas: 1
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 0
      maxSurge: 1
  selector:
    matchLabels:
      app: plus-api
  template:
    metadata:
      labels:
        app: plus-api
    spec:
      terminationGracePeriodSeconds: 30
      containers:
        - name: api
          image: artflow-plus-api
          ports:
            - name: http
              containerPort: 3000
          envFrom:
            - configMapRef:
                name: plus-config
            - secretRef:
                name: plus-secrets
          volumeMounts:
            - name: media
              mountPath: /app/var/media
            - name: archives
              mountPath: /app/var/archives
          startupProbe:
            httpGet:
              path: /readyz
              port: http
            periodSeconds: 5
            failureThreshold: 60
          readinessProbe:
            httpGet:
              path: /readyz
              port: http
            periodSeconds: 5
            failureThreshold: 3
          livenessProbe:
            httpGet:
              path: /healthz
              port: http
            periodSeconds: 10
            failureThreshold: 3
          lifecycle:
            preStop:
              exec:
                command: ["sh", "-c", "sleep 5"]
          resources:
            requests:
              cpu: 250m
              memory: 512Mi
            limits:
              cpu: "1"
              memory: 1Gi
      volumes:
        - name: media
          persistentVolumeClaim:
            claimName: plus-media
        - name: archives
          persistentVolumeClaim:
            claimName: plus-archives
```

- [ ] **Step 2: Commit**

```bash
git add deploy/k8s/base/api.yaml
git commit -m "build: add the Kubernetes API Deployment"
```

---

### Task 9: Worker Deployment

**Files:**
- Create: `deploy/k8s/base/worker.yaml`

- [ ] **Step 1: Write the Deployment**

`deploy/k8s/base/worker.yaml`:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: plus-worker
spec:
  replicas: 1
  selector:
    matchLabels:
      app: plus-worker
  template:
    metadata:
      labels:
        app: plus-worker
    spec:
      terminationGracePeriodSeconds: 30
      containers:
        - name: worker
          image: artflow-plus-worker
          envFrom:
            - configMapRef:
                name: plus-config
            - secretRef:
                name: plus-secrets
          startupProbe:
            exec:
              command: ["sh", "-c", "test -f /tmp/artflow-worker-ready"]
            periodSeconds: 5
            failureThreshold: 60
          readinessProbe:
            exec:
              command: ["sh", "-c", "test -f /tmp/artflow-worker-ready"]
            periodSeconds: 5
            failureThreshold: 3
          livenessProbe:
            exec:
              command: ["sh", "-c", "test -f /tmp/artflow-worker-ready"]
            periodSeconds: 10
            failureThreshold: 6
          resources:
            requests:
              cpu: 100m
              memory: 256Mi
            limits:
              cpu: 500m
              memory: 512Mi
```

- [ ] **Step 2: Commit**

```bash
git add deploy/k8s/base/worker.yaml
git commit -m "build: add the Kubernetes worker Deployment"
```

---

### Task 10: Web Deployment

**Files:**
- Create: `deploy/k8s/base/web.yaml`

- [ ] **Step 1: Write the Deployment**

`deploy/k8s/base/web.yaml`:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: plus-web
spec:
  replicas: 1
  selector:
    matchLabels:
      app: plus-web
  template:
    metadata:
      labels:
        app: plus-web
    spec:
      containers:
        - name: web
          image: artflow-plus-web
          ports:
            - name: http
              containerPort: 8080
          env:
            - name: ARTFLOW_NGINX_RESOLVER
              valueFrom:
                configMapKeyRef:
                  name: plus-config
                  key: ARTFLOW_NGINX_RESOLVER
          readinessProbe:
            httpGet:
              path: /
              port: http
            periodSeconds: 5
            failureThreshold: 3
          livenessProbe:
            httpGet:
              path: /
              port: http
            periodSeconds: 10
            failureThreshold: 3
          resources:
            requests:
              cpu: 50m
              memory: 64Mi
            limits:
              cpu: 250m
              memory: 128Mi
```

The readiness probe uses `/`, not `/healthz`, so a failing API does not remove
the static web tier and worsen an outage. T10 checks `/healthz` explicitly.

- [ ] **Step 2: Commit**

```bash
git add deploy/k8s/base/web.yaml
git commit -m "build: add the Kubernetes web Deployment"
```

---

### Task 11: Proxy Deployment and lab Caddyfile

**Files:**
- Create: `deploy/k8s/base/proxy.yaml`

- [ ] **Step 1: Write the proxy Deployment and ConfigMap**

`deploy/k8s/base/proxy.yaml`:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: caddy-lab
data:
  Caddyfile: |
    {
      auto_https off
    }

    http://:8081 {
      @health path /healthz /healthz/ /readyz /readyz/
      reverse_proxy @health plus-web:8080
    }

    https://artflow.local {
      tls internal
      request_body {
        max_size 128MB
      }
      header -Server
      reverse_proxy plus-web:8080 {
        header_up X-Forwarded-For {remote_host}
        header_up X-Forwarded-Proto https
      }
    }
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: plus-proxy
spec:
  replicas: 1
  selector:
    matchLabels:
      app: plus-proxy
  template:
    metadata:
      labels:
        app: plus-proxy
    spec:
      containers:
        - name: caddy
          image: library/caddy
          args: ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
          ports:
            - name: http
              containerPort: 80
            - name: https
              containerPort: 443
            - name: health
              containerPort: 8081
          volumeMounts:
            - name: config
              mountPath: /etc/caddy
            - name: data
              mountPath: /data
            - name: config-data
              mountPath: /config
          readinessProbe:
            httpGet:
              path: /healthz/
              port: health
            periodSeconds: 5
            failureThreshold: 3
          livenessProbe:
            httpGet:
              path: /healthz/
              port: health
            periodSeconds: 10
            failureThreshold: 3
          resources:
            requests:
              cpu: 50m
              memory: 64Mi
            limits:
              cpu: 250m
              memory: 128Mi
      volumes:
        - name: config
          configMap:
            name: caddy-lab
        - name: data
          emptyDir: {}
        - name: config-data
          emptyDir: {}
```

- [ ] **Step 2: Commit**

```bash
git add deploy/k8s/base/proxy.yaml
git commit -m "build: add the Kubernetes proxy and lab Caddyfile"
```

---

### Task 12: Services

**Files:**
- Create: `deploy/k8s/base/services.yaml`

- [ ] **Step 1: Write the Services**

`deploy/k8s/base/services.yaml`:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: plus-db
spec:
  selector:
    app: plus-db
  ports:
    - name: postgres
      port: 5432
      targetPort: postgres
  clusterIP: None
---
apiVersion: v1
kind: Service
metadata:
  name: plus-api
spec:
  selector:
    app: plus-api
  ports:
    - name: http
      port: 3000
      targetPort: http
---
apiVersion: v1
kind: Service
metadata:
  name: plus-web
spec:
  selector:
    app: plus-web
  ports:
    - name: http
      port: 8080
      targetPort: http
---
apiVersion: v1
kind: Service
metadata:
  name: plus-proxy
spec:
  type: NodePort
  externalTrafficPolicy: Local
  selector:
    app: plus-proxy
  ports:
    - name: http
      port: 80
      targetPort: http
      nodePort: 30080
    - name: https
      port: 443
      targetPort: https
      nodePort: 30443
```

- [ ] **Step 2: Commit**

```bash
git add deploy/k8s/base/services.yaml
git commit -m "build: add the Kubernetes Services"
```

---

### Task 13: Network policies

**Files:**
- Create: `deploy/k8s/base/networkpolicies.yaml`

- [ ] **Step 1: Write the policies**

`deploy/k8s/base/networkpolicies.yaml`:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny
spec:
  podSelector: {}
  policyTypes: ["Ingress", "Egress"]
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-dns
spec:
  podSelector: {}
  policyTypes: ["Egress"]
  egress:
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kube-system
          podSelector:
            matchLabels:
              k8s-app: kube-dns
      ports:
        - protocol: UDP
          port: 53
        - protocol: TCP
          port: 53
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-probes-from-nodes
spec:
  podSelector: {}
  policyTypes: ["Ingress"]
  ingress:
    - from:
        - ipBlock:
            cidr: 192.168.47.0/24
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-proxy-ingress
spec:
  podSelector:
    matchLabels:
      app: plus-proxy
  policyTypes: ["Ingress"]
  ingress:
    - from:
        - ipBlock:
            cidr: 0.0.0.0/0
      ports:
        - protocol: TCP
          port: 80
        - protocol: TCP
          port: 443
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-proxy-to-web
spec:
  podSelector:
    matchLabels:
      app: plus-web
  policyTypes: ["Ingress"]
  ingress:
    - from:
        - podSelector:
            matchLabels:
              app: plus-proxy
      ports:
        - protocol: TCP
          port: 8080
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-web-to-api
spec:
  podSelector:
    matchLabels:
      app: plus-api
  policyTypes: ["Ingress"]
  ingress:
    - from:
        - podSelector:
            matchLabels:
              app: plus-web
      ports:
        - protocol: TCP
          port: 3000
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-api-and-worker-to-db
spec:
  podSelector:
    matchLabels:
      app: plus-db
  policyTypes: ["Ingress"]
  ingress:
    - from:
        - podSelector:
            matchLabels:
              app: plus-api
        - podSelector:
            matchLabels:
              app: plus-worker
      ports:
        - protocol: TCP
          port: 5432
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-proxy-egress
spec:
  podSelector:
    matchLabels:
      app: plus-proxy
  policyTypes: ["Egress"]
  egress:
    - to:
        - podSelector:
            matchLabels:
              app: plus-web
      ports:
        - protocol: TCP
          port: 8080
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-web-egress
spec:
  podSelector:
    matchLabels:
      app: plus-web
  policyTypes: ["Egress"]
  egress:
    - to:
        - podSelector:
            matchLabels:
              app: plus-api
      ports:
        - protocol: TCP
          port: 3000
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-api-egress
spec:
  podSelector:
    matchLabels:
      app: plus-api
  policyTypes: ["Egress"]
  egress:
    - to:
        - podSelector:
            matchLabels:
              app: plus-db
      ports:
        - protocol: TCP
          port: 5432
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-worker-egress
spec:
  podSelector:
    matchLabels:
      app: plus-worker
  policyTypes: ["Egress"]
  egress:
    - to:
        - podSelector:
            matchLabels:
              app: plus-db
      ports:
        - protocol: TCP
          port: 5432
```

`allow-probes-from-nodes` is permissive on purpose: kubelet probes originate
from the node network, and the standard NetworkPolicy API cannot express the
`host` entity. The lab subnet is small and isolated.

- [ ] **Step 2: Commit**

```bash
git add deploy/k8s/base/networkpolicies.yaml
git commit -m "build: add the Kubernetes network policies"
```

---

### Task 14: Overlays and deployment scripts

**Files:**
- Create: `deploy/k8s/overlays/dev/kustomization.yaml`
- Create: `deploy/k8s/overlays/test/kustomization.yaml`
- Create: `deploy/k8s/overlays/restore/kustomization.yaml`
- Create: `scripts/k8s/lib.ps1`
- Create: `scripts/k8s/deploy.ps1`
- Create: `scripts/k8s/reset.ps1`

- [ ] **Step 1: Write the dev overlay**

`deploy/k8s/overlays/dev/kustomization.yaml`:

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: artflow-dev
resources:
  - ../../base
images:
  - name: artflow-plus-api
    newName: 192.168.47.10:5000/artflow-plus-api
    digest: sha256:REPLACE_WITH_API_DIGEST
  - name: artflow-plus-worker
    newName: 192.168.47.10:5000/artflow-plus-worker
    digest: sha256:REPLACE_WITH_WORKER_DIGEST
  - name: artflow-plus-web
    newName: 192.168.47.10:5000/artflow-plus-web
    digest: sha256:REPLACE_WITH_WEB_DIGEST
  - name: library/postgres
    newName: 192.168.47.10:5000/library/postgres
    digest: sha256:REPLACE_WITH_POSTGRES_DIGEST
  - name: library/caddy
    newName: 192.168.47.10:5000/library/caddy
    digest: sha256:REPLACE_WITH_CADDY_DIGEST
secretGenerator:
  - name: plus-secrets
    envs:
      - secrets.env
    options:
      disableNameSuffixHash: true
patches:
  - target:
      kind: Deployment
      name: plus-api
    patch: |-
      - op: add
        path: /spec/template/spec/nodeSelector
        value:
          kubernetes.io/hostname: k8s-worker-2
  - target:
      kind: StatefulSet
      name: plus-db
    patch: |-
      - op: add
        path: /spec/template/spec/nodeSelector
        value:
          kubernetes.io/hostname: k8s-worker-1
  - target:
      kind: Deployment
      name: plus-proxy
    patch: |-
      - op: add
        path: /spec/template/spec/nodeSelector
        value:
          kubernetes.io/hostname: k8s-worker-2
```

Create the other two overlays by copying the dev file and changing exactly one
line:

```powershell
Copy-Item deploy/k8s/overlays/dev/kustomization.yaml deploy/k8s/overlays/test/kustomization.yaml
(Get-Content deploy/k8s/overlays/test/kustomization.yaml -Raw).Replace(
  "namespace: artflow-dev", "namespace: artflow-test") |
  Set-Content deploy/k8s/overlays/test/kustomization.yaml -NoNewline

Copy-Item deploy/k8s/overlays/dev/kustomization.yaml deploy/k8s/overlays/restore/kustomization.yaml
(Get-Content deploy/k8s/overlays/restore/kustomization.yaml -Raw).Replace(
  "namespace: artflow-dev", "namespace: artflow-restore") |
  Set-Content deploy/k8s/overlays/restore/kustomization.yaml -NoNewline
```

- [ ] **Step 2: Write the shared helpers**

`scripts/k8s/lib.ps1`:

```powershell
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$script:RepoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
$script:Kubeconfig = Join-Path $script:RepoRoot ".kube/artflow-lab.yaml"

function Invoke-Kubectl {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
  $output = & kubectl --kubeconfig $script:Kubeconfig @Arguments 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "kubectl $($Arguments -join ' ') failed:`n$output"
  }
  return $output
}

function Wait-Rollout {
  param([string]$Kind, [string]$Name, [string]$Namespace, [int]$Seconds = 300)
  Invoke-Kubectl -n $Namespace rollout status "$Kind/$Name" --timeout="$($Seconds)s"
}

function Assert-Equal {
  param([string]$Label, [string]$Expected, [string]$Actual)
  if ($Expected -ne $Actual) {
    throw "$Label expected '$Expected' but got '$Actual'"
  }
  Write-Host "PASS $Label = $Actual"
}
```

- [ ] **Step 3: Write the deploy script**

`scripts/k8s/deploy.ps1`:

```powershell
[CmdletBinding()]
param(
  [ValidateSet("dev", "test", "restore")][string]$Overlay = "dev",
  [switch]$Reset
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "lib.ps1")

$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
Set-Location $root

$overlayPath = "deploy/k8s/overlays/$Overlay"
$secretPath = Join-Path $overlayPath "secrets.env"
if (-not (Test-Path -LiteralPath $secretPath)) {
  Copy-Item "deploy/k8s/base/secrets.env.example" $secretPath
  $password = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 40 | ForEach-Object { [char]$_ })
  (Get-Content -LiteralPath $secretPath -Raw).
    Replace("replace-with-a-strong-password", $password).
    Replace("replace-with-32-or-more-random-bytes", (-join ((48..57) + (65..90) + (97..122) | Get-Random -Count 64 | ForEach-Object { [char]$_ }))) |
    Set-Content -LiteralPath $secretPath -Encoding utf8
  throw "Created $secretPath. Set ARTFLOW_RELEASE_SHA and the image digests, then rerun."
}

$images = Get-Content -LiteralPath (Join-Path $overlayPath "images.env") | ConvertFrom-StringData
$releaseSha = $images.RELEASE_SHA
$secrets = Get-Content -LiteralPath $secretPath | ConvertFrom-StringData
if ($secrets.ARTFLOW_RELEASE_SHA -ne $releaseSha) {
  throw "ARTFLOW_RELEASE_SHA in $secretPath does not match RELEASE_SHA in images.env"
}

if ($Reset) {
  pwsh -File scripts/k8s/reset.ps1 -Overlay $Overlay
}

$namespace = @{ dev = "artflow-dev"; test = "artflow-test"; restore = "artflow-restore" }[$Overlay]
Invoke-Kubectl apply -k $overlayPath
Wait-Rollout -Kind statefulset -Name plus-db -Namespace $namespace
Wait-Rollout -Kind deployment -Name plus-api -Namespace $namespace
Wait-Rollout -Kind deployment -Name plus-worker -Namespace $namespace
Wait-Rollout -Kind deployment -Name plus-web -Namespace $namespace
Wait-Rollout -Kind deployment -Name plus-proxy -Namespace $namespace
Invoke-Kubectl -n $namespace get pods -o wide
```

- [ ] **Step 4: Write the reset script**

`scripts/k8s/reset.ps1`:

```powershell
[CmdletBinding()]
param(
  [ValidateSet("dev", "test", "restore")][string]$Overlay = "test"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "lib.ps1")

$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
Set-Location $root

$namespace = @{ dev = "artflow-dev"; test = "artflow-test"; restore = "artflow-restore" }[$Overlay]
Invoke-Kubectl -n $namespace delete deployment,statefulset,service,configmap,secret,networkpolicy,pod,persistentvolumeclaim,cronjob,job --all --ignore-not-found
Write-Host "reset $namespace"
```

- [ ] **Step 5: Commit the overlays and scripts**

```bash
git add deploy/k8s/overlays scripts/k8s/lib.ps1 scripts/k8s/deploy.ps1 scripts/k8s/reset.ps1
git commit -m "build: add the Kubernetes overlays and deploy scripts"
```

The build script refuses a dirty tree, so this commit must happen before the
digest render.

- [ ] **Step 6: Render the image digests**

```powershell
pwsh -File scripts/k8s/build-images.ps1
Copy-Item deploy/k8s/overlays/dev/images.env deploy/k8s/overlays/test/images.env -Force
Copy-Item deploy/k8s/overlays/dev/images.env deploy/k8s/overlays/restore/images.env -Force
```

Expected: three pushes; each `kustomization.yaml` no longer contains
`REPLACE_WITH`; each overlay's `images.env` has `RELEASE_SHA` and the three
`ARTFLOW_PLUS_*_DIGEST` values.

- [ ] **Step 7: Commit the rendered digests**

```bash
git add deploy/k8s/overlays
git commit -m "build: pin the lab image digests"
```

---

## Phase 3 — Test matrix

Every task in this phase appends functions to `scripts/k8s/test-matrix.ps1` and
registers each new function in the `$tests` ordered map at the bottom of that
file. After Task 17, for example, the map must contain:

```powershell
$tests["T1"] = ${function:Test-T1}
$tests["T2"] = ${function:Test-T2}
```

Registering a function only after it is defined keeps `-Only` selection
working without evaluating undefined scriptblocks.

### Task 15: Shared test helpers and evidence log

**Files:**
- Create: `scripts/k8s/test-matrix.ps1`
- Create: `docs/artflow-plus/checks/2026-11-10-k8s-deployment-checks.md`

- [ ] **Step 1: Add the curl and evidence helpers**

Append to `scripts/k8s/lib.ps1`:

```powershell
$script:ProxyNode = "192.168.47.12"
$script:ProxyUrl = "https://artflow.local:30443"
$script:EvidencePath = Join-Path $script:RepoRoot "docs/artflow-plus/checks/2026-11-10-k8s-deployment-checks.md"

function Invoke-Curl {
  param(
    [string]$Path,
    [string]$Method = "GET",
    [string[]]$Headers = @(),
    [string]$Body,
    [string]$CookieJar
  )
  $args = @(
    "-k", "-s", "-o", "NUL", "-w", "%{http_code}",
    "--resolve", "artflow.local:30443:$($script:ProxyNode)",
    "-X", $Method,
    "$($script:ProxyUrl)$Path"
  )
  foreach ($header in $Headers) { $args += @("-H", $header) }
  if ($Body) { $args += @("--data-binary", $Body) }
  if ($CookieJar) { $args += @("-b", $CookieJar, "-c", $CookieJar) }
  return (& curl.exe @args)
}

function Invoke-CurlBody {
  param([string]$Path, [string]$Method = "GET", [string[]]$Headers = @(), [string]$Body)
  $args = @(
    "-k", "-s",
    "--resolve", "artflow.local:30443:$($script:ProxyNode)",
    "-X", $Method,
    "$($script:ProxyUrl)$Path"
  )
  foreach ($header in $Headers) { $args += @("-H", $header) }
  if ($Body) { $args += @("--data-binary", $Body) }
  return (& curl.exe @args)
}

function Record-Evidence {
  param([string]$Id, [string]$Name, [string]$Result, [string]$Detail)
  $line = "| $Id | $Name | $Result | $Detail |"
  Add-Content -LiteralPath $script:EvidencePath -Value $line -Encoding utf8
  Write-Host $line
}
```

- [ ] **Step 2: Seed the evidence file**

`docs/artflow-plus/checks/2026-11-10-k8s-deployment-checks.md`:

```markdown
# Kubernetes deployment verification evidence

Cluster: three VMware VMs, Kubernetes v1.36.5, Cilium, Ubuntu 24.04.

| ID | Scenario | Result | Detail |
|---|---|---|---|
```

- [ ] **Step 3: Commit**

```bash
git add scripts/k8s/lib.ps1 docs/artflow-plus/checks/2026-11-10-k8s-deployment-checks.md
git commit -m "test: add the Kubernetes evidence harness"
```

---

### Task 16: T0 and T0n — deployment and provenance

**Files:**
- Modify: `scripts/k8s/test-matrix.ps1` (create it in this task)

- [ ] **Step 1: Create the test script with T0 and T0n**

`scripts/k8s/test-matrix.ps1`:

```powershell
[CmdletBinding()]
param(
  [ValidateSet("dev", "test")][string]$Overlay = "test",
  [string]$Only = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "lib.ps1")

$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
Set-Location $root

$namespace = @{ dev = "artflow-dev"; test = "artflow-test" }[$Overlay]

function Get-PodName {
  param([string]$Label)
  $name = Invoke-Kubectl -n $namespace get pod -l $Label -o jsonpath='{.items[0].metadata.name}'
  if (-not $name) { throw "no pod for $Label" }
  return $name.Trim()
}

function Wait-AllReady {
  Invoke-Kubectl -n $namespace wait --for=condition=Ready pod --all --timeout=180s | Out-Null
}

function Test-T0 {
  Wait-AllReady
  $health = Invoke-Curl "/healthz"
  $ready = Invoke-Curl "/readyz"
  if ($health -ne "200" -or $ready -ne "200") {
    throw "healthz=$health readyz=$ready"
  }
  $worker = Get-PodName "app=plus-worker"
  $readyFile = Invoke-Kubectl -n $namespace exec $worker -- test -f /tmp/artflow-worker-ready
  $db = Get-PodName "app=plus-db"
  $tables = Invoke-Kubectl -n $namespace exec $db -- psql -U artflow_plus -d artflow_plus -Atc "select count(*) from information_schema.tables where table_name in ('kysely_migration','kysely_migration_lock')"
  if ($tables.Trim() -ne "2") { throw "migration tables: $tables" }
  $image = Invoke-Kubectl -n $namespace get pod -l app=plus-api -o jsonpath='{.items[0].status.containerStatuses[0].imageID}'
  $expected = (Get-Content "deploy/k8s/overlays/$Overlay/images.env" | ConvertFrom-StringData).ARTFLOW_PLUS_API_DIGEST
  if ($image -notmatch [regex]::Escape(($expected -split ':')[1])) {
    throw "API digest mismatch: $image"
  }
  $pgLog = Invoke-Kubectl -n $namespace logs $db --tail=50
  if ($pgLog -match "unused mount") { throw "Postgres reported an unused mount" }
  Record-Evidence "T0" "Fresh deploy" "PASS" "pods Ready; healthz/readyz 200; migrations present; digest $expected"
}

function Test-T0n {
  Invoke-Kubectl -n $namespace set env deployment/plus-api "ARTFLOW_RELEASE_SHA=0000000000000000000000000000000000000000"
  $failed = $false
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 2
    $phase = Invoke-Kubectl -n $namespace get pod -l app=plus-api -o jsonpath='{.items[0].status.phase}'
    $waiting = Invoke-Kubectl -n $namespace get pod -l app=plus-api -o jsonpath='{.items[0].status.containerStatuses[0].state.waiting.reason}'
    if ($phase -match "Failed" -or $waiting -match "CrashLoopBackOff|Error") { $failed = $true; break }
  }
  if (-not $failed) { throw "wrong SHA did not fail closed" }
  $logs = Invoke-Kubectl -n $namespace logs -l app=plus-api --tail=20
  if ($logs -notmatch "ARTFLOW_RELEASE_SHA") { throw "failure log does not mention the SHA" }
  Invoke-Kubectl -n $namespace rollout undo deployment/plus-api | Out-Null
  Wait-AllReady
  Record-Evidence "T0n" "Negative provenance" "PASS" "wrong SHA failed closed; log names ARTFLOW_RELEASE_SHA"
}

$tests = [ordered]@{ T0 = ${function:Test-T0}; T0n = ${function:Test-T0n} }
foreach ($key in $tests.Keys) {
  if ($Only -and $key -ne $Only) { continue }
  Write-Host "== $key =="
  & $tests[$key]
}
```

- [ ] **Step 2: Deploy and run T0**

```powershell
pwsh -File scripts/k8s/deploy.ps1 -Overlay test
pwsh -File scripts/k8s/test-matrix.ps1 -Overlay test -Only T0
```

The first `deploy.ps1` run creates `deploy/k8s/overlays/test/secrets.env` and
exits with instructions. Set `ARTFLOW_RELEASE_SHA` to the value in
`deploy/k8s/overlays/test/images.env`, then rerun the two commands.

Expected: `PASS T0 Fresh deploy ...`.

- [ ] **Step 3: Run T0n**

```powershell
pwsh -File scripts/k8s/test-matrix.ps1 -Overlay test -Only T0n
```

Expected: `PASS T0n Negative provenance ...`.

- [ ] **Step 4: Commit**

```bash
git add scripts/k8s/test-matrix.ps1
git commit -m "test: add T0 and T0n cluster deployment checks"
```

---

### Task 17: T1 and T2 — rollout and rollback

**Files:**
- Modify: `scripts/k8s/test-matrix.ps1`

- [ ] **Step 1: Build a synthetic second revision**

From the clean tree, build a second set of images with a different 40-character
marker. The marker is synthetic, not a commit; record that in the evidence.

```powershell
$sha = (git rev-parse HEAD).Trim()
$sha2 = $(if ($sha[0] -ne "f") { "f" } else { "e" }) + $sha.Substring(1)
docker build --platform linux/amd64 --build-arg "ARTFLOW_BUILD_SHA=$sha2" -f deploy/plus/Dockerfile --target api -t "192.168.47.10:5000/artflow-plus-api:$sha2" .
docker push "192.168.47.10:5000/artflow-plus-api:$sha2"
docker inspect --format '{{index .RepoDigests 0}}' "192.168.47.10:5000/artflow-plus-api:$sha2"
```

Record the digest as `T1_API_DIGEST` in the evidence detail.

- [ ] **Step 2: Add T1 and T2**

```powershell
function Test-T1 {
  $sha = (git rev-parse HEAD).Trim()
  $sha2 = $(if ($sha[0] -ne "f") { "f" } else { "e" }) + $sha.Substring(1)
  $digest = (docker inspect --format '{{index .RepoDigests 0}}' "192.168.47.10:5000/artflow-plus-api:$sha2") -split '@' | Select-Object -Last 1
  Invoke-Kubectl -n $namespace scale deployment/plus-api --replicas=2 | Out-Null
  Invoke-Kubectl -n $namespace wait --for=condition=Ready pod -l app=plus-api --timeout=180s | Out-Null

  $probe = Start-Job -ScriptBlock {
    param($url, $node)
    $bad = 0
    for ($i = 0; $i -lt 150; $i++) {
      $code = & curl.exe -k -s -o NUL -w "%{http_code}" --resolve "artflow.local:30443:$node" "$url/healthz"
      if ($code -notin @("200", "101")) { $bad++ }
      Start-Sleep -Milliseconds 200
    }
    $bad
  } -ArgumentList $script:ProxyUrl, $script:ProxyNode

  $patch = @{
    spec = @{
      template = @{
        spec = @{
          containers = @(
            @{
              name = "api"
              image = "192.168.47.10:5000/artflow-plus-api@$digest"
              env = @(@{ name = "ARTFLOW_RELEASE_SHA"; value = $sha2 })
            }
          )
        }
      }
    }
  } | ConvertTo-Json -Depth 10
  Invoke-Kubectl -n $namespace patch deployment/plus-api --type=strategic -p $patch | Out-Null
  Invoke-Kubectl -n $namespace rollout status deployment/plus-api --timeout=300s | Out-Null

  $bad = Receive-Job -Job $probe -Wait
  Remove-Job $probe
  if ($bad -ne 0) { throw "T1 saw $bad non-200 responses" }
  Record-Evidence "T1" "Rolling update" "PASS" "2 replicas; 150 probes at 200ms; 0 non-200; synthetic marker $sha2"
}

function Test-T2 {
  Invoke-Kubectl -n $namespace rollout undo deployment/plus-api | Out-Null
  Invoke-Kubectl -n $namespace rollout status deployment/plus-api --timeout=300s | Out-Null
  $image = Invoke-Kubectl -n $namespace get pod -l app=plus-api -o jsonpath='{.items[0].status.containerStatuses[0].imageID}'
  $migrations = Invoke-Kubectl -n $namespace exec (Get-PodName "app=plus-db") -- psql -U artflow_plus -d artflow_plus -Atc "select count(*) from kysely_migration"
  Record-Evidence "T2" "Rollback" "PASS" "rollout undo restored the previous ReplicaSet; migrations=$($migrations.Trim())"
}
```

- [ ] **Step 3: Run T1 and T2**

```powershell
pwsh -File scripts/k8s/test-matrix.ps1 -Overlay test -Only T1
pwsh -File scripts/k8s/test-matrix.ps1 -Overlay test -Only T2
```

Expected: both PASS. If T1 reports 5xx, add a `preStop` sleep (already in the
manifest) and record the residual window.

- [ ] **Step 4: Commit**

```bash
git add scripts/k8s/test-matrix.ps1
git commit -m "test: add rollout and rollback checks"
```

---

### Task 18: T3 and T4 — self-healing and drain

**Files:**
- Modify: `scripts/k8s/test-matrix.ps1`

- [ ] **Step 1: Add T3 and T4**

```powershell
function Test-T3 {
  $before = Invoke-Kubectl -n $namespace exec (Get-PodName "app=plus-db") -- psql -U artflow_plus -d artflow_plus -Atc "select count(*) from outbox where published_at is null"
  foreach ($label in @("app=plus-api", "app=plus-worker", "app=plus-web", "app=plus-db")) {
    Invoke-Kubectl -n $namespace delete pod -l $label --wait=false | Out-Null
  }
  Start-Sleep -Seconds 10
  Wait-AllReady
  $after = Invoke-Kubectl -n $namespace exec (Get-PodName "app=plus-db") -- psql -U artflow_plus -d artflow_plus -Atc "select count(*) from outbox where published_at is null"
  if ([int]$after -gt [int]$before) { throw "outbox backlog grew: $before -> $after" }
  Record-Evidence "T3" "Self-healing" "PASS" "all pods recreated; unpublished outbox $before -> $after"
}

function Test-T4 {
  Invoke-Kubectl drain k8s-worker-2 --ignore-daemonsets --delete-emptydir-data --force --timeout=120s | Out-Null
  $pending = Invoke-Kubectl -n $namespace get pods --field-selector=status.phase=Pending --no-headers
  Invoke-Kubectl uncordon k8s-worker-2 | Out-Null
  Invoke-Kubectl drain k8s-worker-1 --ignore-daemonsets --delete-emptydir-data --force --timeout=120s | Out-Null
  $dbPending = Invoke-Kubectl -n $namespace get pod plus-db-0 --no-headers
  Invoke-Kubectl uncordon k8s-worker-1 | Out-Null
  Start-Sleep -Seconds 20
  Wait-AllReady
  Record-Evidence "T4" "Node drain" "PASS" "worker-2 pending: $($pending -join '; '); worker-1 db: $dbPending"
}
```

T4 is expected to show Pending pods because local-path volumes are node-pinned.
Record the exact names; a drain that reports no Pending pods is a stricter result
and may be recorded as PASS with the observed placement.

PDB check, after the drains are recorded:

```powershell
kubectl --kubeconfig .kube/artflow-lab.yaml -n artflow-test create pdb plus-api-pdb `
  --selector=app=plus-api --min-available=1
kubectl --kubeconfig .kube/artflow-lab.yaml drain k8s-worker-2 `
  --ignore-daemonsets --delete-emptydir-data --dry-run=server
```

Expected: the drain reports a disruption-budget conflict. Delete the temporary
PDB afterwards and record the output.

- [ ] **Step 2: Run T3 and T4**

```powershell
pwsh -File scripts/k8s/test-matrix.ps1 -Overlay test -Only T3
pwsh -File scripts/k8s/test-matrix.ps1 -Overlay test -Only T4
```

- [ ] **Step 3: Commit**

```bash
git add scripts/k8s/test-matrix.ps1
git commit -m "test: add self-healing and drain checks"
```

---

### Task 19: T5 — storage and restore

**Files:**
- Modify: `scripts/k8s/test-matrix.ps1`

- [ ] **Step 1: Add T5**

```powershell
function Test-T5 {
  $db = Get-PodName "app=plus-db"
  $api = Get-PodName "app=plus-api"
  $backup = Join-Path $root "logs/k8s/backup"
  New-Item -ItemType Directory -Force -Path $backup | Out-Null

  Invoke-Kubectl -n $namespace exec $db -- pg_dump -U artflow_plus -d artflow_plus -Fc -f /tmp/backup.dump
  Invoke-Kubectl cp -n $namespace "$($db):/tmp/backup.dump" "$backup/database.dump"
  Invoke-Kubectl -n $namespace exec $api -- tar czf /tmp/media.tgz -C /app/var media
  Invoke-Kubectl cp -n $namespace "$($api):/tmp/media.tgz" "$backup/media.tgz"
  Invoke-Kubectl -n $namespace exec $api -- tar czf /tmp/archives.tgz -C /app/var archives
  Invoke-Kubectl cp -n $namespace "$($api):/tmp/archives.tgz" "$backup/archives.tgz"

  Invoke-Kubectl -n $namespace delete pod -l app=plus-db --wait=false | Out-Null
  Start-Sleep -Seconds 10
  Wait-AllReady
  $rows = Invoke-Kubectl -n $namespace exec (Get-PodName "app=plus-db") -- psql -U artflow_plus -d artflow_plus -Atc "select count(*) from kysely_migration"
  if ([int]$rows -lt 1) { throw "database did not survive pod deletion" }

  Copy-Item "deploy/k8s/overlays/test/secrets.env" "deploy/k8s/overlays/restore/secrets.env" -Force
  Copy-Item "deploy/k8s/overlays/test/images.env" "deploy/k8s/overlays/restore/images.env" -Force
  pwsh -File scripts/k8s/deploy.ps1 -Overlay restore
  $rns = "artflow-restore"
  $rdb = (Invoke-Kubectl -n $rns get pod -l app=plus-db -o jsonpath='{.items[0].metadata.name}').Trim()
  Invoke-Kubectl cp -n $rns "$backup/database.dump" "$($rdb):/tmp/backup.dump"
  Invoke-Kubectl -n $rns exec $rdb -- pg_restore -U artflow_plus -d artflow_plus --clean --if-exists /tmp/backup.dump
  $restored = Invoke-Kubectl -n $rns exec $rdb -- psql -U artflow_plus -d artflow_plus -Atc "select count(*) from kysely_migration"
  if ([int]$restored -lt 1) { throw "restore produced no migration rows" }

  Record-Evidence "T5" "Storage and backup" "PASS" "database and file archives captured and restored into artflow-restore"
}
```

- [ ] **Step 2: Run T5**

```powershell
pwsh -File scripts/k8s/test-matrix.ps1 -Overlay test -Only T5
```

Expected: PASS. If `pg_restore --clean` conflicts with the restore namespace's
fresh schema, drop and recreate the database in the restore namespace first and
record the command.

- [ ] **Step 3: Commit**

```bash
git add scripts/k8s/test-matrix.ps1 deploy/k8s/overlays/restore
git commit -m "test: add storage and restore checks"
```

---

### Task 20: T6 — multiple replicas

**Files:**
- Modify: `scripts/k8s/test-matrix.ps1`

- [ ] **Step 1: Add T6**

```powershell
function Test-T6 {
  Invoke-Kubectl -n $namespace scale deployment/plus-api --replicas=2 | Out-Null
  Invoke-Kubectl -n $namespace scale deployment/plus-worker --replicas=2 | Out-Null
  Invoke-Kubectl -n $namespace wait --for=condition=Ready pod -l app=plus-api --timeout=180s | Out-Null
  Invoke-Kubectl -n $namespace wait --for=condition=Ready pod -l app=plus-worker --timeout=180s | Out-Null

  $nodes = Invoke-Kubectl -n $namespace get pod -l app=plus-api -o jsonpath='{.items[*].spec.nodeName}'
  $db = Get-PodName "app=plus-db"
  $before = Invoke-Kubectl -n $namespace exec $db -- psql -U artflow_plus -d artflow_plus -Atc "select count(*) from outbox where published_at is null"
  Start-Sleep -Seconds 20
  $after = Invoke-Kubectl -n $namespace exec $db -- psql -U artflow_plus -d artflow_plus -Atc "select count(*) from outbox where published_at is null"
  if ([int]$after -gt [int]$before) { throw "outbox backlog grew with two workers" }

  $health = Invoke-Curl "/healthz"
  if ($health -ne "200") { throw "healthz=$health with two API replicas" }
  $workerLogs = Invoke-Kubectl -n $namespace logs -l app=plus-worker --tail=100
  if ($workerLogs -match "relayError|duplicate projection") { throw "worker reported relay errors" }
  Record-Evidence "T6" "Multiple replicas" "PASS" "api nodes=[$nodes]; outbox $before -> $after; healthz 200; no relay errors"
}
```

- [ ] **Step 2: Run T6**

```powershell
pwsh -File scripts/k8s/test-matrix.ps1 -Overlay test -Only T6
```

If the second API replica is Pending because of the RWO media PVC, record the
pod events and the storage-class limitation instead of forcing a pass.

- [ ] **Step 3: Scale back to one replica**

```powershell
kubectl --kubeconfig .kube/artflow-lab.yaml -n artflow-test scale deployment/plus-api --replicas=1
kubectl --kubeconfig .kube/artflow-lab.yaml -n artflow-test scale deployment/plus-worker --replicas=1
```

- [ ] **Step 4: Commit**

```bash
git add scripts/k8s/test-matrix.ps1
git commit -m "test: add multi-replica checks"
```

---

### Task 21: T7 and T7b — configuration, secrets, proxy identity

**Files:**
- Modify: `scripts/k8s/test-matrix.ps1`

- [ ] **Step 1: Add T7 and T7b**

```powershell
function Test-T7 {
  Invoke-Kubectl -n $namespace set env deployment/plus-api ARTFLOW_PLUS_DATABASE_URL= | Out-Null
  $failed = $false
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 2
    $reason = Invoke-Kubectl -n $namespace get pod -l app=plus-api -o jsonpath='{.items[0].status.containerStatuses[0].state.waiting.reason}'
    if ($reason -match "CrashLoopBackOff|Error") { $failed = $true; break }
  }
  if (-not $failed) { throw "empty database URL did not fail closed" }
  Invoke-Kubectl -n $namespace rollout undo deployment/plus-api | Out-Null
  Wait-AllReady

  $podBefore = Get-PodName "app=plus-api"
  $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("lab-secret-2"))
  Invoke-Kubectl -n $namespace patch secret plus-secrets --type=merge `
    -p "{`"data`":{`"ARTFLOW_PLUS_CREDENTIAL_SECRET`":`"$encoded`"}}" | Out-Null
  Start-Sleep -Seconds 5
  $podAfter = Get-PodName "app=plus-api"
  if ($podBefore -ne $podAfter) { throw "a bare Secret update restarted pods unexpectedly" }
  Invoke-Kubectl -n $namespace rollout restart deployment/plus-api | Out-Null
  Wait-AllReady
  Record-Evidence "T7" "Configuration and secrets" "PASS" "empty database URL failed closed; bare Secret update did not restart; explicit restart applied it"
}

function Test-T7b {
  $codes = @()
  for ($i = 1; $i -le 11; $i++) {
    $codes += Invoke-Curl -Path "/api/auth/login" -Method POST `
      -Headers @("Content-Type: application/json", "X-Forwarded-For: 203.0.113.$i") `
      -Body '{"username":"rate-limit-probe","password":"wrong-password"}'
  }
  if ($codes -notcontains "429") { throw "forged X-Forwarded-For changed the rate-limit identity: $($codes -join ',')" }
  Record-Evidence "T7b" "Proxy identity" "PASS" "11 forged XFF attempts shared one IP bucket; 429 observed"
}
```

- [ ] **Step 2: Run T7 and T7b**

```powershell
pwsh -File scripts/k8s/test-matrix.ps1 -Overlay test -Only T7
pwsh -File scripts/k8s/test-matrix.ps1 -Overlay test -Only T7b
```

- [ ] **Step 3: Commit**

```bash
git add scripts/k8s/test-matrix.ps1
git commit -m "test: add configuration and proxy identity checks"
```

---

### Task 22: T8 — resources and HPA

**Files:**
- Modify: `scripts/k8s/test-matrix.ps1`

- [ ] **Step 1: Add T8**

```powershell
function Test-T8 {
  $top = Invoke-Kubectl -n $namespace top pods --no-headers
  if (-not $top) { throw "metrics are not available" }

  Invoke-Kubectl -n $namespace set resources deployment/plus-api --limits=memory=64Mi | Out-Null
  $oom = $false
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 2
    $reason = Invoke-Kubectl -n $namespace get pod -l app=plus-api -o jsonpath='{.items[0].status.containerStatuses[0].lastState.terminated.reason}'
    if ($reason -match "OOMKilled") { $oom = $true; break }
  }
  Invoke-Kubectl -n $namespace rollout undo deployment/plus-api | Out-Null
  Wait-AllReady

  Invoke-Kubectl -n $namespace autoscale deployment/plus-api --cpu-percent=50 --min=1 --max=2
  Start-Sleep -Seconds 60
  $hpa = Invoke-Kubectl -n $namespace get hpa plus-api
  $restarts = Invoke-Kubectl -n $namespace get pod -l app=plus-api -o jsonpath='{.items[*].status.containerStatuses[*].restartCount}'
  if (-not $oom) { throw "64Mi limit did not produce an OOMKilled restart" }
  Record-Evidence "T8" "Resources and scheduling" "PASS" "OOMKilled observed; metrics available; hpa: $($hpa -join ' '); restarts=$restarts"
}
```

- [ ] **Step 2: Run T8**

```powershell
pwsh -File scripts/k8s/test-matrix.ps1 -Overlay test -Only T8
```

The OOM step lowers the API memory limit to `64Mi`, waits for
`lastState.terminated.reason=OOMKilled`, then undoes the change. If the process
does not exceed 64Mi, record the observed working set and use a lower limit in a
second attempt.

- [ ] **Step 3: Remove the test HPA**

```powershell
kubectl --kubeconfig .kube/artflow-lab.yaml -n artflow-test delete hpa plus-api --ignore-not-found
```

- [ ] **Step 4: Commit**

```bash
git add scripts/k8s/test-matrix.ps1
git commit -m "test: add resource and HPA checks"
```

---

### Task 23: T9 — network boundary

**Files:**
- Modify: `scripts/k8s/test-matrix.ps1`

- [ ] **Step 1: Add T9**

```powershell
function Test-T9 {
  $pod = Invoke-Kubectl -n $namespace run netprobe --image=192.168.47.10:5000/library/busybox:1.36 --restart=Never --command -- sleep 300
  try {
    Start-Sleep -Seconds 8
    $db = Invoke-Kubectl -n $namespace exec netprobe -- sh -c 'nc -z -w 3 plus-db 5432; echo exit=$?'
    $api = Invoke-Kubectl -n $namespace exec netprobe -- sh -c 'nc -z -w 3 plus-api 3000; echo exit=$?'
    if ($db -match "exit=0") { throw "database reachable from an unlabeled pod" }
    if ($api -match "exit=0") { throw "API reachable from an unlabeled pod" }
    $outside = Invoke-Curl "/healthz"
    if ($outside -ne "200") { throw "NodePort healthz=$outside" }
    $media = Invoke-CurlBody "/media/probe"
    if ($media -notmatch '<div id="root">') { throw "media path served something other than the SPA" }
    Record-Evidence "T9" "Network boundary" "PASS" "unlabeled pod denied db/api; NodePort healthz 200; media path serves the SPA"
  } finally {
    Invoke-Kubectl -n $namespace delete pod netprobe --ignore-not-found | Out-Null
  }
}
```

- [ ] **Step 2: Run T9**

```powershell
pwsh -File scripts/k8s/test-matrix.ps1 -Overlay test -Only T9
```

If the CNI enforces policy only for labeled pods, record which identities were
denied and which were allowed.

- [ ] **Step 3: Commit**

```bash
git add scripts/k8s/test-matrix.ps1
git commit -m "test: add network boundary checks"
```

---

### Task 24: T10 — proxy chain and secure cookies

**Files:**
- Modify: `scripts/k8s/test-matrix.ps1`

- [ ] **Step 1: Add T10**

```powershell
function Test-T10 {
  New-Item -ItemType Directory -Force -Path (Join-Path $root "logs/k8s") | Out-Null
  $jar = Join-Path $root "logs/k8s/cookies.txt"
  $user = "lab" + (Get-Random -Maximum 999999)
  $headers = & curl.exe -k -s -D - -o NUL -c $jar --resolve "artflow.local:30443:$($script:ProxyNode)" `
    -X POST -H "Content-Type: application/json" `
    --data-binary "{`"username`":`"$user`",`"password`":`"lab-password-123`"}" `
    "$($script:ProxyUrl)/api/auth/register"
  if ($headers -notmatch "HTTP/[0-9.]+ 201") { throw "registration failed: $headers" }
  if ($headers -notmatch "Secure") { throw "session cookie is not Secure" }
  $me = Invoke-Curl -Path "/api/auth/me" -CookieJar $jar
  if ($me -ne "200") { throw "authenticated me=$me" }

  $upgrade = & curl.exe -k -s -i -N --http1.1 --resolve "artflow.local:30443:$($script:ProxyNode)" `
    -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" `
    -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" "$($script:ProxyUrl)/api/realtime"
  if ($upgrade -notmatch "101") { throw "websocket upgrade failed: $upgrade" }

  $big = Join-Path $root "logs/k8s/big.bin"
  fsutil file createnew $big 135266304 | Out-Null
  $tooLarge = Invoke-Curl -Path "/api/auth/login" -Method POST -Headers @("Content-Type: application/json") -Body "@$big"
  if ($tooLarge -ne "413") { throw "body limit returned $tooLarge (Caddy must reject with 413)" }
  Remove-Item $big -Force
  Record-Evidence "T10" "Proxy chain" "PASS" "register 201 with Secure cookie; me 200; websocket 101; oversized body $tooLarge"
}
```

- [ ] **Step 2: Run T10**

```powershell
pwsh -File scripts/k8s/test-matrix.ps1 -Overlay test -Only T10
```

The oversized body must be rejected by Caddy with `413`. A `400` means Caddy
forwarded the request, so the limit is not enforced and the test fails.

- [ ] **Step 3: Commit**

```bash
git add scripts/k8s/test-matrix.ps1
git commit -m "test: add proxy chain and secure cookie checks"
```

---

## Phase 4 — Runbook, evidence, and close-out

### Task 25: Operator runbook

**Files:**
- Create: `docs/artflow-plus/k8s-deployment-test.md`

- [ ] **Step 1: Write the runbook**

The runbook must contain these sections, with the exact commands from Tasks 1–24:

```markdown
# Kubernetes deployment verification

## Scope
One-lab verification only; Compose remains the production authority.

## Prerequisites
Node 24, Docker Desktop, kubectl, SSH access to the three VMs, a clean checkout.

## Bootstrap
The root steps and the least-privilege checks.

## Build and push
`scripts/k8s/build-images.ps1`, the digest record, and the clean-tree rule.

## Deploy
`scripts/k8s/deploy.ps1 -Overlay dev|test|restore`, what each namespace is for.

## Test matrix
T0–T10 with the command and the expected result for each.

## Known limits
RWO local-path pinning, Caddy `emptyDir` CA, NodePort `externalTrafficPolicy`,
and the absence of a real failure domain.

## Teardown
`scripts/k8s/teardown.ps1`, what it keeps.

## Troubleshooting
Image pull failures, resolver errors, Secure-cookie symptoms, migration waits.
```

- [ ] **Step 2: Run the documentation gate**

```powershell
pwsh -NoProfile -File scripts/check_docs.ps1
```

Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add docs/artflow-plus/k8s-deployment-test.md
git commit -m "docs: add the Kubernetes deployment runbook"
```

---

### Task 26: Evidence log and teardown script

**Files:**
- Modify: `docs/artflow-plus/checks/2026-11-10-k8s-deployment-checks.md`
- Create: `scripts/k8s/teardown.ps1`

- [ ] **Step 1: Fill the evidence file**

After running the matrix, the file contains one row per scenario. Add a short
paragraph above the table recording the release SHA, the image digests, the
cluster version, and any scenario recorded as a limitation.

- [ ] **Step 2: Write the teardown script**

`scripts/k8s/teardown.ps1`:

```powershell
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "lib.ps1")

$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
Set-Location $root

foreach ($namespace in @("artflow-dev", "artflow-test", "artflow-restore")) {
  Invoke-Kubectl -n $namespace delete deployment,statefulset,service,configmap,secret,networkpolicy,pod,persistentvolumeclaim,cronjob,job,hpa --all --ignore-not-found
}
Write-Host "application workloads removed; bootstrap components kept"
```

- [ ] **Step 3: Commit**

```bash
git add docs/artflow-plus/checks/2026-11-10-k8s-deployment-checks.md scripts/k8s/teardown.ps1
git commit -m "docs: record the Kubernetes evidence and add teardown"
```

---

### Task 27: Knowledge-base update

**Files:**
- Modify: `C:\Users\16275\Desktop\PersonalKnowledgeBase\01-Projects\K8sLab.md`

- [ ] **Step 1: Append the ArtFlow section**

Add a section with:

- the ArtFlow-Plus deployment topology and namespaces;
- the local registry and containerd `certs.d` requirement;
- the nginx resolver portability rule;
- Secure cookies forcing TLS in production mode;
- the RWO local-path limits for rolling updates and multi-replica API;
- the migration advisory-lock behaviour and the startup probe rule;
- the exact commands for rebuild/rollout/rollback.

- [ ] **Step 2: Commit in the knowledge-base repository**

```bash
cd C:\Users\16275\Desktop\PersonalKnowledgeBase
git add 01-Projects/K8sLab.md
git commit -m "ArtFlow: record the Kubernetes deployment verification"
```

---

### Task 28: Final gates, merge, and push

**Files:** none

- [ ] **Step 1: Run the full local gate**

```powershell
Set-Location C:\Users\16275\Desktop\ArtFlow
pnpm -C plus run check
$env:ARTFLOW_PLUS_DATABASE_URL = "postgresql://artflow:artflow_dev@127.0.0.1:5433/artflow_plus"
$env:REQUIRE_DB = "1"
pnpm -C plus run test
pnpm -C plus run schema:check
pnpm -C plus run build:prod
uv run pytest tests/gates -q
uv run python tests/golden/validate_fixtures.py
pwsh -NoProfile -File scripts/check_docs.ps1
```

Expected: all pass.

- [ ] **Step 2: Review the diff for secrets and generated files**

```powershell
git status --short
git diff --check
git diff --stat
```

Confirm `.kube/`, `secrets.env`, logs, and backups are absent.

- [ ] **Step 3: Commit any remaining scoped files**

```bash
git add deploy/k8s deploy/plus/nginx.conf.template deploy/plus/nginx.conf deploy/plus/Dockerfile \
  deploy/compose.production.yml .env.production.example .gitignore \
  scripts/k8s docs/artflow-plus/k8s-deployment-test.md \
  docs/artflow-plus/checks/2026-11-10-k8s-deployment-checks.md \
  tests/gates/test_release_artifacts.py
git commit -m "build: verify the Kubernetes deployment path"
```

- [ ] **Step 4: Merge with a non-fast-forward merge and push**

```bash
git switch main
git pull --ff-only origin main
git merge --no-ff build/k8s-deployment-verification
git push origin main
```

Expected: the branch merges without rewriting shared history and the push
succeeds. If the push times out, retry through the local proxy described in
`AGENTS.md`.

