# Ticket Replay API Review Implementation Plan

> **For agentic workers:** Execute this plan inline in the current repository checkout; do not delegate work to subagents.

**Goal:** Align the ticket replay comment with the implemented cookie behavior and lock that behavior with an API integration test.

**Architecture:** Keep the existing redacted HTTP response contract. The runtime rebuilds the sensitive access token only for an idempotent replay, and the API sets the HttpOnly ticket cookie from that rebuilt value while returning `accessToken: null`.

**Tech Stack:** Fastify inject, Vitest, PostgreSQL/Kysely, `@artflow-plus/runtime` ticket service.

**Spec:** `docs/artflow-plus/specs/2026-10-28-ticket-backed-voting-design.md`

## Global Constraints

- Run only Plus checks/tests; do not run the 1.x Django suite or real rehearsal.
- Keep raw ticket credentials out of persisted command responses and HTTP response bodies.
- Use a real PostgreSQL schema for the API integration test when `REQUIRE_DB=1`.
- Preserve the existing branch/worktree policy and make one scoped conventional commit.

---

### Task 1: Cover HTTP ticket replay recovery

**Files:**
- Modify: `plus/apps/api/src/app.ts:608`
- Create: `plus/apps/api/test/ticket-redeem.test.ts`

**Interfaces:**
- Consumes: `POST /api/tickets/redeem`, `issueTicket`, `authenticateTicketSession`.
- Produces: proof that the first response and an idempotent replay both set the same HttpOnly ticket cookie while returning `accessToken: null`.

- [ ] Write a PostgreSQL-backed API test that seeds an active ticketing activity, issues a ticket, redeems it once, replays the same `Idempotency-Key`, compares both `Set-Cookie` headers, authenticates the cookie token, and asserts neither body exposes `accessToken`.
- [ ] Run the focused API test with `REQUIRE_DB=1` and confirm the route behavior.
- [ ] Update the stale `sessionTokenValue` comment to describe redacted response bodies and replay cookie recovery.
- [ ] Run Plus type checks and focused API tests.
- [ ] Commit only this review follow-up.
