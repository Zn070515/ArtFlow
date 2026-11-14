# Production Release Readiness Specification

## Goal

Close every code-level issue identified in `C:\Users\16275\Desktop\advices\ChatGPT.md` before the next `main` push, while preserving the existing ArtFlow authority contract. The release must be reproducible, recoverable, privacy-aware, resource-bounded, and operable by a production owner without relying on undocumented local-only behavior.

## Scope

This specification covers the production boundary around the frozen ArtFlow core:

- backup consistency, provenance, media verification, off-host transfer, and restore evidence;
- upload safety, storage quotas, rate limits, file validation, and reverse-proxy request limits;
- PII-safe audit and archive behavior, privacy notice, and retention tooling;
- account password lifecycle and authentication abuse controls;
- neutral public branding, configurable ICP metadata, and staged HSTS;
- image/release pinning, exact-image restore, POSIX operations, health checks, logs, and monitoring hooks;
- complete tests and documentation for each boundary.

The following remain external deployment prerequisites and must never be represented as locally passed: real DNS ownership, public certificate issuance, school SSO/MFA approval, WAF/volumetric-DDoS capacity, OSS credentials, ICP filing, and an actual ECS failure-domain restore. The repository must provide executable checks/runbooks for them and the release record must state whether the external evidence exists.

## Non-negotiable contracts

1. No direct ORM write may bypass existing scoring, result, vote, ticket, judge, or release authority services.
2. Backups must be created under an application-wide write barrier; the barrier must fail closed and be visible in audit/diagnostics without storing secrets or PII.
3. A backup manifest must identify the exact source revision, image identity, migration state, file/database digests, and complete referenced-file verification result.
4. A permanent archive must not contain contact PII. Operational contact exports remain explicitly separate and access-controlled.
5. Upload acceptance must use server-side content inspection, bounded per-owner storage/version policy, rate limiting, and low-disk rejection.
6. Audit records for PII edits record field names and change flags only; they never copy old/new contact values.
7. Production defaults are fail-closed. Event/rehearsal exceptions must be explicit and cannot silently affect production.
8. No fake ICP number, recovery email flow, external smoke result, OSS transfer, or DDoS claim may be added.
9. Every production behavior change gets a focused regression test before implementation and a small conventional commit after the focused gate passes.
10. `main` is not merged or pushed until the complete local release gate, two self-review passes, and the final status/remote check succeed.

## Acceptance matrix

| Advice item | Required repository outcome | Evidence |
|---|---|---|
| P0-1 | Restore helper derives the PostgreSQL image/version from the production manifest or receives a verified matching image; no PG17 drift | script contract + restore test |
| P0-2 | Backup helper defaults to `/app/backups` and does not strand the only copy in a container layer | script contract + command test |
| P0-3 | Off-host sync and restore path exist with private/encrypted/lifecycle configuration; credentials are never committed | script, config contract, docs, isolated compatible-store rehearsal if credentials are available |
| P0-4 | Every database-referenced file is checked, not a five-row sample | command regression with a late missing file |
| P0-5 | Backup runs inside a fail-closed global write barrier and records the barrier state | service/command regression |
| P0-6 | Registration/contact updates redact old/new values from audit | model/view regression |
| P0-7 | Per-owner/purpose quotas, bounded retained versions, upload rate limits, and low-disk guard exist | service regressions and configuration contract |
| P0-8 | Production Caddy body limit is 120 MB; event remains separately explicit | Compose/Caddy contract |
| P0-9 | Signature/structure inspection covers images, audio/video, PDF, ZIP/DOCX at accepted upload boundaries | adversarial upload matrix |
| P0-10 | Privacy/retention notice is linked and shown before PII collection | route/template tests |
| P0-11 | Current release has fresh local gate evidence; remote CI is triggered only after final merge | release checklist |
| P1-12/13 | Explicit SHA is validated and tied to baked image revision | command/Docker contract |
| P1-14 | Restore uses the image identity recorded by the backup, or refuses an unverified mismatch | restore contract |
| P1-15 | Permanent archive strips contact columns; operational export remains separate | export/archive regression |
| P1-16 | Admin-only retention/anonymization command exists and preserves scoring authority | command tests |
| P1-17 | Authenticated password change and audited admin reset exist; no fake email recovery | account tests |
| P1-18 | Login buckets use IP+username plus a higher IP aggregate; registration has explicit abuse threshold | rate-limit tests |
| P1-19/20 | Public title is neutral; ICP is optional configuration only | template/settings tests |
| P1-21 | HSTS is environment-configurable with safe staged defaults | settings tests |
| P1-22 | Proxy healthcheck and external HTTPS smoke script/runbook exist | Compose/script contract |
| P1-23/24 | Image identities are configurable/pinnable; release build/export records exact SHA and digest | Docker/release script tests/docs |
| P1-25 | POSIX deploy/backup/restore verification entry points exist | shell syntax/contract tests |
| P2 | Log rotation, monitoring checklist, complete manifest counts, pre-restore digest checks, and deployment-profile separation are documented/implemented | tests/docs |

## Out of scope

- New competition features or changes to scoring/result/release semantics.
- Removal of historical migrations or destructive database/volume reset.
- Claiming that local tests are a substitute for external school/network/OSS evidence.

