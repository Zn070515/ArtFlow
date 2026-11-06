# ADR-0023: Main-domain replacement and the rollback boundary

- **Status**: accepted
- **Date**: 2026-10-26

## Decision

The first v2 cutover replaces the v1 site on the **main domain**; v1 and v2 are
not routed per activity or per path. Caddy selects a complete site profile file
through `ARTFLOW_SITE_PROFILE` (`v1` or `v2`); switching is changing that value
and recreating the proxy container. The v2 profile points at `plus-web:8080`,
which serves the SPA and proxies `/api` to `plus-api:3000`.

Plus runs beside v1 on the same host as a Compose profile with its own
PostgreSQL service, database, volumes, credential secret, and a separately
deployed `plus-worker` outbox relay. v1 remains
running, read-only, for at least one full activity cycle after the switch; its
database and media are backed up before the switch and are the rollback source.

The first cutover happens **after registration closes**. v2 takes over Ops,
Studio, Live, and public results; participants are read-only (public results).
Imported registrations stay staff-visible; participant account migration is a
later slice.

**Rollback is allowed only before the first authoritative v2 write.** After the
switch, v1 accepts no writes; changing `ARTFLOW_SITE_PROFILE` back to `v1` and
recreating the proxy restores the full v1 site. Once a v2 write is accepted, the
window closes and the team moves forward (fix or hotfix) instead of switching
back. v2-only writes made before the commit point must be re-entered in v1 or
explicitly abandoned, and that choice is recorded.

## Alternatives rejected

- Per-activity or per-path routing between v1 and v2: two session models and two
  path semantics on one host invite silent split-brain; the first cutover does
  not need gradual traffic shaping.
- Dual-write or v2→v1 replay: requires a bidirectional model mapping and turns
  the cutover into a much larger project.
- Long-lived pilot hostname as the production entry: it is useful for
  rehearsal, but the accepted switch is the main-domain replacement and no
  second public entry is kept.
- Keeping v1 writable after the switch: both systems could accept the same
  authority, making rollback meaningless.

## Consequences

- The switch is reproducible from `.env.production` and the Caddy site files;
  the proxy container is recreated because its config/env changed.
- The commit point is an operational event, not a code flag; the runbook records
  the first write and closes rollback.
- v1 media is not exposed through the v2 domain; media bytes remain a v1
  concern until the media gateway slice.
- Plus images are split into `plus-api` and `plus-worker` (esbuild bundles) and
  `plus-web` (nginx + Vite build); the workspace's TypeScript packages are not
  loaded at runtime. API rate limits trust forwarded addresses only when
  `ARTFLOW_PLUS_TRUST_PROXY` names the internal proxy, and the reverse proxy
  body ceiling is 128 MiB while domain material policy remains authoritative.
