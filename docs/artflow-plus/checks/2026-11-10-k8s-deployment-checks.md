# Kubernetes deployment verification evidence

Cluster: three VMware VMs (`k8s-control`, `k8s-worker-1`, `k8s-worker-2`),
Kubernetes v1.36.5, Cilium, Ubuntu 24.04.

Release: app artifact built at commit
`ca4c0f731faa75a3ecb5272b7df653ced63476ed`, pinned by digest:

| Image | Digest |
| --- | --- |
| `artflow-plus-api` | `sha256:023fc974cd8bdaf3a34a66fd2998fcbfac97fe58b9113e24b352bbc12d3b8f06` |
| `artflow-plus-worker` | `sha256:7263b04f1289b0319b33c4e85e92f17342c0a3cf90f84660037deded3936e8ba` |
| `artflow-plus-web` | `sha256:a8aa23adda56f2f809f856b78c5d7b9b14311d65467023fea2bdb3928b8fb48a` |
| `postgres` | `sha256:dccfb624111cd5c2139ccb4e9bf12588c8676e0d4e852fa949998f9a01c7b3bd` |
| `caddy` | `sha256:8151f2ea469a220cc7d6ba5a5d581d9dd3a312793743ce59ab506fd9585a204a` |

| ID | Scenario | Result | Detail |
|---|---|---|---|
| T0 | Fresh deploy | PASS | pods Ready; healthz/readyz 200; migrations present; API digest matches the recorded digest |
| T0n | Negative provenance | PASS | a wrong `ARTFLOW_RELEASE_SHA` crashed the new pod; logs name the release marker; rollback restored service |
| T1 | Rolling update | PASS | config rollout; 150 probes at 200ms; 0 non-200; real image rollouts also completed during deployment |
| T2 | Rollback | PASS | `rollout undo` completed; migration count unchanged at 23 |
| T3 | Self-healing | PASS | API, worker, web, and database pods recreated; unpublished outbox 0 -> 0 |
| T4 | Node drain | PASS | draining worker-2 left the node-pinned API and proxy Pending until uncordon; a PDB with minAvailable=1 reported zero allowed disruptions |
| T5 | Storage and restore | PASS | database dump restored into a scratch database; media and archive tarballs captured; database pod deletion preserved data |
| T6 | Multiple replicas | PASS | api=2 worker=2; outbox 0 -> 0; healthz 200; no relay errors |
| T7 | Configuration and secrets | PASS | empty database URL failed closed; a bare Secret update did not restart pods; an explicit restart applied it |
| T7b | Proxy identity | PASS | 11 forged `X-Forwarded-For` attempts shared one IP bucket; 429 observed |
| T8 | Resources and scheduling | PASS | OOMKilled observed at a 32Mi limit; metrics available; HPA created and removed |
| T9 | Network boundary | PASS | an unlabeled pod was denied database and API access; NodePort healthz 200; media path serves the SPA |
| T10 | Proxy chain | PASS | register 201 with a Secure cookie; `/api/auth/me` 200; WebSocket 101; oversized body 413 |

## Scope notes

- T1 used `kubectl rollout restart`, a configuration rollout. The earlier real
  image rollout from `81372d8` to `ca4c0f7` completed during deployment; its
  probe evidence is the deployment log, not this table.
- T2 rolled back a config-only change, so an old image against a newer schema
  was not exercised. The rollback command and migration count are recorded.
- T4 is a lab limit: the API and proxy are pinned to `k8s-worker-2` and use
  node-local storage, so draining that node leaves them Pending. Production
  needs RWX or object storage before a multi-node rollout is meaningful.
- T5 restores into a scratch database in the same PostgreSQL pod. It proves the
  dump and the file archives are restorable; it is not a namespace-level
  disaster-recovery rehearsal.
- T8's HPA was created after the OOM check; no sustained load was generated, so
  the replica count stayed at one.
