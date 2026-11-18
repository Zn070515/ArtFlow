# HA reference: CloudNativePG + S3

This directory is the **reference** multi-node deployment. The Compose file
remains the single-node authority; `deploy/k8s/base` remains the lab topology.
Nothing here is applied automatically.

## What changes

- PostgreSQL becomes a CloudNativePG cluster (`plus-db`, 3 instances) with
  S3 WAL/data archiving and a 30-day retention policy.
- The API, worker and web run two replicas behind the existing Services; PDBs
  keep one of each available during drains.
- Material and archive bytes move to an S3-compatible bucket, so the API no
  longer mounts the local media/archive PVCs.
- Sessions, rate limits and the outbox live in PostgreSQL, so any API replica
  can serve any request. Each replica polls the outbox for realtime invalidation;
  duplicate invalidation messages are harmless and no Redis is required.

## Apply

1. Install the CloudNativePG operator in the cluster.
2. Create the S3 and application secrets:
   `kubectl apply -f backup-credentials.example.yaml` after replacing values.
3. Point `ARTFLOW_PLUS_DATABASE_URL` in `plus-secrets` at the CNPG read-write
   service: `postgresql://artflow_plus:<password>@plus-db-rw:5432/artflow_plus`.
4. Add the S3 settings to `plus-secrets` (or the HA ConfigMap):
   `ARTFLOW_PLUS_STORAGE_DRIVER=s3`, `ARTFLOW_PLUS_S3_BUCKET`,
   `ARTFLOW_PLUS_S3_REGION`, optional `ARTFLOW_PLUS_S3_ENDPOINT` and
   `ARTFLOW_PLUS_S3_FORCE_PATH_STYLE=1` for MinIO.
5. Apply the operator cluster and the overlay:

```bash
kubectl apply -f deploy/k8s/cnpg/cluster.yaml
kubectl apply -k deploy/k8s/overlays/ha
```

6. Verify readiness and a round trip:

```bash
kubectl -n artflow-dev get cluster plus-db
kubectl -n artflow-dev get pods -l app=plus-api
curl -fsS https://<host>/readyz
```

## Point-in-time recovery

1. Copy `recovery-cluster.example.yaml` and set `targetTime` to the last known
   good instant.
2. Apply it as a **new** cluster named `plus-db-recovered`.
3. Wait for `kubectl -n artflow-dev get cluster plus-db-recovered` to report
   healthy, then run the application smoke checks against a temporary API
   deployment pointed at `plus-db-recovered-rw`.
4. Only after verification, switch `ARTFLOW_PLUS_DATABASE_URL` to the recovered
   read-write service. Keep the original cluster/backups until the retention
   window expires.

Recovery is a new cluster, never an in-place restore. Do not delete the source
cluster or its S3 prefix as part of the drill.

## Limits

- The operator and bucket are deployment inputs; this repository cannot prove
  the bucket's immutability, lifecycle rules or cross-region replication.
- `imageName` must be pinned to a verified CNPG/PostgreSQL 18 image digest.
- Multi-replica API assumes S3 (or another shared object store) for media.
  Local volumes remain single-node only.
