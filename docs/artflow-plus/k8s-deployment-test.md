# Kubernetes deployment verification

This runbook verifies that the ArtFlow-Plus release images deploy, roll, heal,
and recover on the lab Kubernetes cluster. It is a verification environment,
not a production authority: `deploy/compose.production.yml` remains the
production deployment, and the evidence for the last run is in
[the checks record](checks/2026-11-10-k8s-deployment-checks.md).

## Prerequisites

- Node 24, pnpm 12, Docker Desktop, kubectl, and PowerShell 7 on Windows.
- SSH access to `k8s-control`, `k8s-worker-1`, and `k8s-worker-2` with
  `~/.ssh/k8s_lab_ed25519`.
- A clean checkout on a short-lived branch.

## One-time bootstrap

1. Enable passwordless sudo for the login user (the console or an interactive
   terminal prompts once per node):

   ```powershell
   pwsh -NoProfile -File scripts/k8s/enable-lab-sudo.ps1
   ```

2. Copy the bootstrap assets to the control node and run the per-node
   containerd configuration:

   ```powershell
   ssh k8s-control "mkdir -p /home/xuxin/artflow-bootstrap"
   scp -r deploy/k8s/bootstrap/. k8s-control:/home/xuxin/artflow-bootstrap/
   ```

   On each node, as root:

   ```bash
   bash /path/to/bootstrap-node.sh
   ```

3. On `k8s-control` as root, install the cluster pieces:

   ```bash
   bash /home/xuxin/artflow-bootstrap/bootstrap-control.sh
   ```

4. Copy the deployer kubeconfig to the workstation:

   ```powershell
   New-Item -ItemType Directory -Force .kube
   scp k8s-control:/home/xuxin/artflow-lab.kubeconfig .kube/artflow-lab.yaml
   ```

The deployer ServiceAccount has `edit` in `artflow-dev`, `artflow-test`, and
`artflow-restore`; it cannot create or delete namespaces, and node operations
such as `drain` run through the control node's admin kubeconfig.

## Build and push

```powershell
pwsh -NoProfile -File scripts/k8s/build-images.ps1
pwsh -NoProfile -File scripts/k8s/push-images.ps1
```

`build-images.ps1` refuses a dirty tree, builds the three targets from
`deploy/plus/Dockerfile`, and saves the image tarballs. `push-images.ps1` copies
the tarballs to the control node and uses `skopeo` to push them to the
in-cluster registry, so the Docker daemon's proxy configuration is not changed.
Both scripts update `deploy/k8s/overlays/*/images.env` and the digest pins.

## Deploy

```powershell
pwsh -NoProfile -File scripts/k8s/deploy.ps1 -Overlay test
```

The first run creates `deploy/k8s/overlays/<overlay>/secrets.env` and exits.
Set `ARTFLOW_RELEASE_SHA` from `images.env`, then rerun. The script applies the
overlay, waits for every rollout, and prints the pods.

## Test matrix

```powershell
pwsh -NoProfile -File scripts/k8s/test-matrix.ps1 -Overlay test -Only T0
pwsh -NoProfile -File scripts/k8s/test-matrix.ps1 -Overlay test -Only T3
pwsh -NoProfile -File scripts/k8s/test-matrix.ps1 -Overlay test -Only T10
```

Run one scenario at a time. The destructive scenarios (T3, T4, T5, T6, T7, T8)
are intended for `artflow-test`; `artflow-dev` is kept for inspection.
Available IDs are `T0`, `T0n`, `T1`, `T2`, `T3`, `T4`, `T5`, `T6`, `T7`,
`T7b`, `T8`, `T9`, and `T10`.

## Known limits

- The API and proxy are pinned to `k8s-worker-2`; the database to
  `k8s-worker-1`. Media and archive volumes are local-path RWO. Draining the
  API node leaves those pods Pending until the node is uncordoned.
- The proxy uses `tls internal` with an `emptyDir` CA. Clients must use `-k` or
  ignore certificate errors; a stable internal CA needs a persistent volume.
- The proxy Service uses `externalTrafficPolicy: Local`, so clients target the
  node that runs the proxy.
- The local-path helper pod uses the lab registry image; the upstream helper
  image is on Docker Hub, which this network cannot reach.
- The web image resolves the API by its fully-qualified service name because the
  nginx `resolver` directive does not apply the pod search domain.

## Teardown

```powershell
pwsh -NoProfile -File scripts/k8s/teardown.ps1
pwsh -NoProfile -File scripts/k8s/disable-lab-sudo.ps1
```

Teardown removes application workloads and data; the bootstrap components and
the namespaces remain. `disable-lab-sudo.ps1` removes the temporary
passwordless sudo rule.

## Troubleshooting

- Image pull from the local registry fails: confirm the registry pod is running
  with host networking on `192.168.47.10:5000` and that each node has
  `/etc/containerd/certs.d/192.168.47.10:5000/hosts.toml`.
- The web returns 502 for `/api`: check `ARTFLOW_NGINX_RESOLVER` and
  `ARTFLOW_NGINX_API_HOST` inside the web pod and confirm the rendered config
  contains the fully-qualified service name.
- The proxy crashes: check that its Caddyfile has `tls internal` and no
  `auto_https off` global option, and that its health endpoint returns 200.
- A PVC stays Pending: inspect the `local-path-provisioner` events; the helper
  pod must pull from the lab registry, not Docker Hub.
