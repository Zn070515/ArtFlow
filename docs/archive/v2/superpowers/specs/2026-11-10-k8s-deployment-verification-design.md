# ArtFlow-Plus Kubernetes Deployment Verification — Design

- Date: 2026-11-10
- Status: accepted for implementation; self-reviewed
- Scope owner: repository maintainer
- Environment: three VMware Workstation VMs (`k8s-control`, `k8s-worker-1`,
  `k8s-worker-2`), Kubernetes v1.36.5, Cilium, Ubuntu 24.04.

## Goal

Prove that the ArtFlow-Plus release artifacts — the `api`, `worker`, and `web`
images produced by `deploy/plus/Dockerfile` — deploy, roll, heal, and recover
correctly on a standard Kubernetes cluster. The tests cover only behaviour that
the local Docker Compose path cannot exercise: scheduler placement, rollout and
rollback, pod and node failure, storage reattachment, multi-replica concurrency,
network policy, and the proxy chain that is baked into the image.

This is a verification environment, not a production target and not a second
test suite. Unit, integration, golden, schema-drift, and browser E2E tests stay
local. A behaviour that can be observed under Compose is out of scope here; the
cluster checks only exercise the deployment path and the properties that path
adds.

## Non-goals

- Public DNS, ACME certificates, multi-cluster deployment, or high availability
  across physical hosts.
- Replacing `deploy/compose.production.yml` as the production authority, or
  treating the cluster backup script as a replacement for the Compose
  [backup and restore contract](../../../../artflow-plus/backup-restore.md).
- Reworking the Compose manifest beyond the one resolver variable required by
  F1.
- Helm, Operators, service meshes, or GitOps controllers.
- Shipping a supported Kubernetes distribution to customers.
- Re-running the full browser E2E suite inside the cluster.

## Environment constraints that shape the design

| Constraint | Observed state | Consequence |
|---|---|---|
| Administrative access | `xuxin` has read-only RBAC; passwordless sudo was removed; root SSH is refused | Cluster-level bootstrap needs one root session through the VMware console |
| Image registry | Docker Hub is unreachable (`000`); GHCR and its NJU mirror respond | Base images come from a reachable mirror; application images are built locally and pushed to an in-cluster registry |
| Storage | No StorageClass, no PV, no PVC | Install a provisioner during bootstrap |
| Metrics | metrics-server absent | Install it during bootstrap for HPA and `kubectl top` |
| Ingress | No Ingress or Gateway controller | Expose the stack with a Service of type `NodePort` |
| Control plane | `node-role.kubernetes.io/control-plane:NoSchedule` | Application pods schedule on the two workers |
| Migration | `apps/api/src/main.ts` and `apps/worker/src/worker.ts` call `migrate` on start; Kysely takes a PostgreSQL advisory lock with a one-hour `lock_timeout` | No migrate-only entry point is added; rollout tests must observe the lock wait and the Deployment progress deadline |
| Realtime | `RealtimeHub` polls topic snapshots per process (`packages/realtime/src/server/hub.ts`) | Multiple API replicas are expected to work; the test verifies rather than assumes |
| Outbox | `relayOutboxOnce` claims partitions with advisory locks | Multiple worker replicas are expected to be safe; the test verifies no duplicate projection |
| Release provenance | `assertReleaseProvenance` requires a 40-character SHA in production that equals `/app/ARTFLOW_RELEASE_SHA` | Build argument and Secret must agree; a deliberate mismatch is a negative test |

## Architecture

Namespaces:

- `artflow-dev` is long-lived, holds a seeded scratch state, and serves manual
  inspection.
- `artflow-test` is disposable. Every destructive scenario deletes the
  namespaced resources in it and reapplies the overlay.
- `artflow-restore` is pre-created and used only by T5, so a restore can be read
  without destroying the test namespace.

The deployer ServiceAccount receives `edit` in these three namespaces. It does
not have cluster-wide namespace creation or deletion, so scenarios reset
resources instead of deleting namespaces.

Workloads:

| Workload | Kind | Replicas | Notes |
|---|---|---|---|
| `plus-db` | StatefulSet | 1 | `postgres:18`, PVC at `/var/lib/postgresql` (the 18.x image mount point) |
| `plus-api` | Deployment | 1, scaled to 2 for T6 | `ARTFLOW_PLUS_INLINE_RELAY=0` |
| `plus-worker` | Deployment | 1, scaled to 2 for T6 | readiness file `/tmp/artflow-worker-ready` |
| `plus-web` | Deployment | 1 | nginx static site plus `/api` proxy |
| `plus-proxy` | Deployment | 1 | Caddy with `tls internal`, NodePort 30080/30443 |

Service names must match the Compose names because the built images contain
those hostnames: `plus-db`, `plus-api`, `plus-web`, `plus-proxy`.

Configuration lives in one ConfigMap and one Secret per namespace. Secrets are
generated locally from a tracked `.example` file; real values never enter the
repository. Every image reference — application and base — is digest-pinned; a
mirror is used only as transport, and the digest is obtained from the mirror and
verified before it enters the manifest.
The worker mounts no media or archive volume; the API mounts the `plus-media`
and `plus-archives` PVCs at the paths the image already expects.

Resource requests and limits are set for every container so scheduling, OOM,
and HPA behaviour are observable rather than accidental.

Lab placement accommodates the local-path RWO limitation rather than hiding it:
the database is pinned to `k8s-worker-1`, the API and its media/archive PVCs to
`k8s-worker-2`, and web/proxy are spread. This makes a two-replica zero-downtime
API rollout possible on one node. It is a lab accommodation, not a production
recommendation; a production deployment needs RWX or object storage before API
replicas may span nodes.

The API and worker use a `startupProbe` sized for the migration wait (for
example, 5-second intervals with 60 failures) so a slow migration cannot be
killed by a liveness probe. Liveness and readiness start only after the
process listens and the ready file exists.

## One-time bootstrap (root, VMware console)

The bootstrap is the only phase that needs root. It is scripted so it can be
re-run idempotently and audited.

1. Install `local-path-provisioner` and mark its StorageClass as default.
2. Install metrics-server with `--kubelet-insecure-tls`.
3. Run a local registry on the control node (hostPort 5000, PVC-backed) and
   configure the three containerd instances to allow it over HTTP. Push or
   pre-pull `postgres:18`, `caddy:2-alpine`, and `busybox` through a reachable
   mirror so later steps never depend on Docker Hub.
4. Create namespaces `artflow-system`, `artflow-dev`, `artflow-test`, and
   `artflow-restore`. Create ServiceAccount `artflow-deployer` in
   `artflow-system` and RoleBindings to `edit` in the three application
   namespaces. Issue a one-year token with `kubectl create token` and build
   `.kube/artflow-lab.yaml`.
5. Verify least privilege from the workstation: creating a Deployment in
   `artflow-dev` is allowed; creating or deleting a namespace is denied.

The kubeconfig, token, registry credentials, and database password never enter
the repository. `.gitignore` must cover `.kube/` and local Secret files before
the first commit that references them.

## Image supply

1. Build from a clean checkout at the recorded commit. The build script refuses
   a dirty tree, because a dirty image cannot be reproduced from the recorded
   SHA.
2. Build with the repository Dockerfile on the workstation:
   `docker build --platform linux/amd64 --build-arg ARTFLOW_BUILD_SHA=<40-char SHA> -f deploy/plus/Dockerfile --target <api|worker|web>`.
3. Tag and push to `192.168.47.10:5000/artflow-plus-<target>:<sha>`. Docker
   Desktop needs `insecure-registries: ["192.168.47.10:5000"]` once.
4. Record the pushed digest and write it into the overlay. Manifests reference
   `image@sha256:...`, never a floating tag.
5. A release-candidate verification pass repeats the same build from the CI
   output: same Dockerfile, same SHA, verified digest. The only difference is
   the transport path.

## Required artifact fixes discovered during design

### F1 — nginx resolver is Docker-specific

`deploy/plus/nginx.conf` hardcodes `resolver 127.0.0.11`, the Docker embedded
DNS address. Under Kubernetes the `/api` proxy cannot resolve `plus-api`, so the
web container returns 502 for every API call.

Fix: replace `deploy/plus/nginx.conf` with `deploy/plus/nginx.conf.template`
containing `${ARTFLOW_NGINX_RESOLVER}`, copy it to
`/etc/nginx/templates/default.conf.template` in the web image, and set the
variable to `127.0.0.11` in Compose and to `kube-dns.kube-system.svc.cluster.local`
(or `10.96.0.10`) in Kubernetes. The image stays environment-portable. The
official nginx entrypoint runs `envsubst` only over variables that exist in the
environment, so nginx's own `$host`, `$uri`, and `$plus_api` tokens are left
intact. Both Compose and the k8s overlay must set the variable; an unset value
produces an invalid `resolver` directive and the container fails closed.

### F2 — secure session cookies require TLS

`apps/api/src/app.ts` sets `Secure` on session and CSRF cookies whenever the
environment is production. Over a plain HTTP NodePort the browser never returns
them, so login and every CSRF-protected write fail. The design keeps
`APP_ENV=production` and terminates TLS at Caddy with `tls internal`; tests use
`-k` or ignore certificate errors. Lowering `APP_ENV` is rejected because it
would skip release-provenance and credential-secret validation, making the test
prove less than it appears to.

Caddy's data directory uses `emptyDir` in the lab. The internal CA therefore
regenerates when the proxy pod restarts, and the tests always use `-k`, so no
persistent trust is expected. A production deployment that needs a stable
internal CA must give that directory a persistent volume. Tests resolve the site
address with `curl --resolve` or a hosts entry; no public DNS is involved. The
proxy runs a lab-specific Caddyfile ConfigMap that keeps the 128 MiB body limit
and the health block but replaces public ACME with `tls internal`.

## Test matrix

Each test is a scripted scenario with a command, an expected result, and stored
evidence. Scenarios marked destructive run in `artflow-test`. A scenario that
cannot pass because of a documented environment limit is recorded as such, never
skipped silently.

| ID | Scenario | Pass condition |
|---|---|---|
| T0 | Fresh deploy | All pods Ready; `/healthz` and `/readyz` return 200; worker ready file exists; `kysely_migration` and `kysely_migration_lock` exist; the running image digest equals the recorded digest; `ARTFLOW_RELEASE_SHA` equals both the build SHA and the baked marker; the Postgres log shows no unused-mount warning and its data directory is the PVC |
| T0n | Negative provenance | Running the real image with a mismatched `ARTFLOW_RELEASE_SHA`, with the variable empty, or with the Secret absent fails to start, and the failure is visible in events and logs |
| T1 | Rolling update | Run with two API replicas on the API node; `maxUnavailable=0`; 30 seconds of probes at 200 ms intervals during the roll see no 5xx; old pods leave the endpoints before termination. If 5xx appear, record whether a `preStop` delay is required. A single-replica run is recorded separately and does not claim zero downtime |
| T2 | Rollback | `kubectl rollout undo` restores the previous ReplicaSet; the observed schema/image mismatch is recorded, not hidden |
| T3 | Self-healing | Deleting api, worker, web, and db pods leads to recreation; the outbox drains; no committed data is lost |
| T4 | Node drain | Draining the non-database worker reschedules its pods; draining the database node leaves the local-path database pod Pending and is recorded as an expected RWO limitation; a PDB with `minAvailable: 1` blocks eviction and reports the budget conflict |
| T5 | Storage and backup | Data survives a Postgres pod deletion; a Job pinned to the node that holds the local-path volumes dumps the database and archives the media and archive PVCs; restoring all three into `artflow-restore` serves the restored data |
| T6 | Multiple replicas | api=2 and worker=2 produce no 5xx, no duplicate projection, working snapshot polling, and working DB-backed rate limiting. If the second API replica lands on another node, the RWO media PVC blocks it; that is recorded as a storage-class limitation |
| T7 | Configuration and secrets | Missing database URL, missing credential secret, and a wrong SHA each fail closed. A bare Secret update does not restart pods; an explicit `rollout restart` applies the new value |
| T7b | Proxy identity | `ARTFLOW_PLUS_TRUST_PROXY` set to the pod CIDR makes `X-Forwarded-For` meaningful, and an untrusted source cannot spoof it. The proxy Service uses `externalTrafficPolicy: Local` so Caddy sees the real client; if SNAT is observed instead, that is recorded |
| T8 | Resources and scheduling | Requests and limits are enforced; an OOM restart is observable; HPA scales on CPU once metrics-server is present and resource requests exist |
| T9 | Network boundary | Cilium default-deny policy allows DNS and only proxy→web→api→db and worker→db application traffic; the proxy admits NodePort traffic from outside the cluster; database and worker are unreachable externally; media and archives have no static route |
| T10 | Proxy chain | Caddy→nginx→api serves `/api`, upgrades `/api/realtime`, enforces the 128 MiB body limit, and completes a Secure-cookie login over the internal TLS certificate |

Seeding uses the HTTP API, or the source tree's existing seed scripts through a
`kubectl port-forward` to the database, always into a dedicated lab schema or
database. Direct SQL writes to business facts are not used, matching the
repository's authority rule.

Evidence is written to `docs/artflow-plus/checks/2026-11-10-k8s-deployment-checks.md`.

## Implementation order

1. Bootstrap (root session) and least-privilege verification.
2. Local registry, image build/push, and the F1 image change.
3. Base manifests: db, api, worker, web, proxy, services, config, secrets.
4. T0/T0n and the first manual smoke through the proxy chain.
5. Destructive matrix T1–T10, fixing artifacts or recording limits.
6. Runbook, evidence file, and knowledge-base update.
7. Teardown script that removes application resources and keeps the bootstrap
   components (provisioner, metrics-server, registry, RBAC) available.

## Deliverables

- `deploy/k8s/base/` — namespaced manifests: db, api, worker, web, proxy,
  services, config, policies, and the lab Caddyfile ConfigMap with `tls internal`.
- `deploy/k8s/overlays/dev/` and `deploy/k8s/overlays/test/` — environment
  differences and pinned digests.
- `deploy/k8s/bootstrap/` — provisioner, metrics-server, registry, RBAC, and
  base-image prefetch scripts.
- `scripts/k8s/` — PowerShell build-push, deploy, test-matrix, reset, and
  teardown scripts.
- `docs/artflow-plus/k8s-deployment-test.md` — operator runbook.
- `docs/artflow-plus/checks/2026-11-10-k8s-deployment-checks.md` — evidence log.
- The F1 nginx template change, the Compose environment entry, and the
  `.env.production.example` entry required by the configuration sweep.
- A `.gitignore` entry for `.kube/` and local Secret files.
- A knowledge-base update in `K8sLab.md` covering the lab rules and pitfalls.

## Acceptance criteria

1. A fresh `artflow-test` namespace reaches T0 and T0n with the recorded digests.
2. T1, T2, T3, T5, T6, T7, T7b, T8, and T10 pass with stored evidence.
3. T4 and T9 document either a pass or a precise, reproducible limitation.
4. The local release gates still pass after F1:
   `pnpm -C plus run check`, `pnpm -C plus run test`, `pnpm -C plus run build:prod`,
   `pnpm -C plus run schema:check`, `uv run pytest tests/gates -q`,
   `uv run python tests/golden/validate_fixtures.py`,
   `pwsh -NoProfile -File scripts/check_docs.ps1`.
5. No credential, kubeconfig, token, or generated archive is committed.
6. The teardown script leaves the cluster without application workloads but
   with the four pre-created namespaces and the bootstrap components intact.

## Risks and rollback

- The registry and containerd configuration are host-level changes. Back up the
  original `config.toml` and `hosts.toml` files, record the exact rollback
  commands, and do not touch kubelet or cgroup settings.
- If Docker Desktop routes `192.168.47.10` through the workstation's corporate
  proxy, add the VM subnet to the proxy bypass list; otherwise `docker push`
  reaches the proxy instead of the registry.
- `local-path` storage pins the database to one node. This is a known limit, not
  a defect; tests record it rather than hiding it.
- Ephemeral test resources are reset resource-by-resource because the deployer
  cannot delete namespaces. Deleting `artflow-dev` requires a deliberate
  cluster-admin action.
- If console bootstrap is unavailable, the fallback is a temporary narrow sudo
  rule limited to `kubectl` and `ctr`, removed immediately afterwards. The
  read-only RBAC for `xuxin` is not widened.
- The Compose backup contract remains the production authority. The k8s backup
  Job in T5 proves the storage and restore path, not equivalence with
  `scripts/backup_plus.sh`.
- The Compose manifest mounts the database volume at
  `/var/lib/postgresql/data`, while the development baseline requires
  `/var/lib/postgresql` for the 18.x image. The k8s manifest follows the
  baseline; the Compose discrepancy is recorded here and is not changed by this
  work.
