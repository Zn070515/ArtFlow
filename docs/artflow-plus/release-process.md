# ArtFlow-Plus release process

The repository deliberately has no automatic release on `main`. A release is a
maintainer action: a signed tag is the release authority, and `publish.yml`
builds the four digest-pinned images from that exact commit.

## Before tagging

1. Run the manual **Release readiness** workflow with the intended version.
   It runs all gates and `build:prod`, but does **not** tag or push images.
2. Confirm the deployment inputs for this release: PostgreSQL/CNPG version,
   S3 bucket and prefixes, SMTP/OIDC settings, and the digest source registry.
3. Review `docs/artflow-plus/roadmap.md` and the ADR index for the changes that
   belong to the version.

## Tag and publish

```bash
git switch main
git pull --ff-only origin main
git tag -s v2.0.0 -m "ArtFlow-Plus v2.0.0"
git push origin v2.0.0
```

`publish.yml` then runs the release gates, builds `artflow-plus-api`,
`artflow-plus-worker`, `artflow-plus-web`, and `artflow-plus-export`, and pushes
them with provenance and attestations. Pin the resulting `@sha256:` digests in
`.env.production` together with `ARTFLOW_RELEASE_SHA`.

## After publishing

- Verify `/readyz` and a public read against the released stack.
- Record the release digest set and the rollback digest set in the deployment
  record.
- Never move or delete a published tag; corrections are a new version.
