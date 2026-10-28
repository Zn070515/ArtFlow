# Ticket-Backed Voting Implementation Plan

> For agentic workers: REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

Goal: Complete the public ArtFlow-Plus ticket-backed voting journey using the existing one-time ticket redemption and HttpOnly access-session authority.

Architecture: Extend the existing public vote read model with a non-sensitive ticketReady flag and ticket-scoped voted lookup. The API authenticates the HttpOnly ticket session before reading, while the existing locked submitBallot service remains the final authority for activity, session, ticket state, and uniqueness. The Web page accepts a credential only from a URL fragment or an explicit input, exchanges it once, clears the fragment, and submits only { type: "ticket" } afterward.

Tech Stack: TypeScript 7, Fastify 5, Kysely/PostgreSQL 18, TypeBox, React 19, TanStack Query/Router, Vitest, Playwright.

Spec: docs/artflow-plus/specs/2026-10-28-ticket-backed-voting-design.md

## Global Constraints

- Work only on the artflow-plus line and feature branch feat/ticket-backed-voting.
- Do not add a migration; use the existing ticket, ticket_access_session, ballot.ticket_id, and unique constraints.
- Do not accept a raw ticket credential in ballot JSON; only the HttpOnly artflow_ticket_session cookie may authorize ticket identity.
- Do not expose raw credential, ticket digest, ticketId, or access-session id in public vote responses.
- Preserve browser and anonymous voting behavior and formal-only public visibility.
- Follow TDD: each production change is preceded by a failing focused test.
- Run Plus-focused tests only; skip real rehearsal and full Django tests.

## File Map

- Modify plus/packages/db/src/voting-ticket-repository.ts: add the ticket-scoped ballot existence query.
- Modify plus/packages/runtime/src/voting-read-service.ts: compute ticketReady and ticket voted without exposing identity data.
- Modify plus/packages/contracts/src/voting.ts: add the ticketReady public-read field.
- Modify plus/apps/api/src/app.ts: authenticate the HttpOnly ticket cookie for public vote reads and pass only safe ticket identity context to runtime.
- Modify plus/apps/api/test/public-vote.test.ts: prove ticket readiness, voted state, invalid-cookie fail-closed behavior, and ticket ballot HTTP submission.
- Modify plus/apps/web/src/api/vote.ts: add ticket redemption and ticket ballot submission helpers.
- Modify plus/apps/web/src/routes/vote.tsx: implement fragment/input redemption, fragment scrubbing, ticket-ready rendering, and error mapping.
- Modify plus/apps/api/scripts/seed-voting.ts: seed one formal ticket-policy E2E activity and clean its ticket rows on reseed.
- Modify plus/apps/web/e2e/vote-page.spec.ts: prove ticket redemption, voting, refresh recovery, and duplicate protection through the real browser.
- Modify docs/artflow-plus/roadmap.md, docs/artflow-plus/shape-validation.md, and plus/README.md: close the documented ticket-entry gap.
- Create docs/artflow-plus/specs/2026-10-28-ticket-backed-voting-design.md: preserve the accepted security and UX contract.

---

### Task 1: Make the public read ticket-aware

Files:
- Modify: plus/packages/db/src/voting-ticket-repository.ts
- Modify: plus/packages/runtime/src/voting-read-service.ts
- Modify: plus/packages/contracts/src/voting.ts
- Modify: plus/apps/api/src/app.ts
- Test: plus/apps/api/test/public-vote.test.ts

Interfaces:
- Produce hasBallotForTicket(db, sessionId, ticketId): Promise<boolean>.
- Extend PublicVoteSessionState and PublicVoteSession with ticketReady: boolean.
- Change readPublicVoteSession(db, sessionId, browserFingerprint?, ticketIdentity?) so optional ticket identity is { activityId: string; ticketId: string }.
- The API passes an AuthenticatedTicketSession only after authenticateTicketSession succeeds and its activity matches the public session activity.

- [ ] Step 1: Write failing API tests.

Seed a ticket-policy formal session, insert a redeemed ticket/access session, then assert:

    expect(response.json()).toMatchObject({
      identityPolicy: "ticket",
      ticketReady: true,
      voted: false,
    });

Insert a ballot for the same ticket and assert voted: true; send an invalid or expired ticket cookie and assert ticketReady: false and voted: false; assert the response still has no ticketId, credential, accessToken, or counts fields.

- [ ] Step 2: Run the focused test and verify the expected failure.

    $env:ARTFLOW_PLUS_DATABASE_URL = "postgresql://artflow:artflow_dev@127.0.0.1:5433/artflow_plus"
    $env:REQUIRE_DB = "1"
    pnpm -C plus --filter @artflow-plus/api exec vitest run test/public-vote.test.ts

Expected: FAIL because ticketReady is absent and the route does not authenticate artflow_ticket_session for public reads.

- [ ] Step 3: Add the minimal repository/runtime/API implementation.

Implement the ticket query as a ballot lookup constrained by session_id, identity_type = 'ticket', and ticket_id. In readPublicVoteSession, set ticketReady only for a same-activity ticket identity and use the new query for voted. In the public route, catch authenticateTicketSession failures and treat them as no ticket identity; never send the raw cookie to the read model or response.

- [ ] Step 4: Run the focused test and verify it passes.

Run the same Vitest command. Expected: all public-vote tests pass, including ticket ready/voted and fail-closed cases.

- [ ] Step 5: Commit the read-model slice.

    git add plus/packages/db/src/voting-ticket-repository.ts plus/packages/runtime/src/voting-read-service.ts plus/packages/contracts/src/voting.ts plus/apps/api/src/app.ts plus/apps/api/test/public-vote.test.ts
    git commit -m "feat: expose ticket-ready public voting state"

### Task 2: Add the browser ticket exchange API

Files:
- Modify: plus/apps/web/src/api/vote.ts
- Test: plus/apps/web/src/api/vote.test.ts

Interfaces:
- Produce redeemTicket(credential: string): Promise<void> calling POST /api/tickets/redeem with an idempotency key and { credential }.
- Extend submitVote identity to browser | ticket | anonymous; ticket submissions still send only { type: "ticket" }.

- [ ] Step 1: Write failing Web API tests.

Mock only the browser fetch boundary and assert redeemTicket sends the credential to /api/tickets/redeem with a unique idempotency key, while submitVote(..., "ticket") sends no credential in its JSON body.

- [ ] Step 2: Run the focused Web test and verify it fails.

    pnpm -C plus --filter @artflow-plus/web exec vitest run src/api/vote.test.ts

Expected: FAIL because redeemTicket is not exported and submitVote does not accept ticket identity.

- [ ] Step 3: Implement the minimal API helpers.

Use the existing apiFetch so same-origin credentials and CSRF behavior remain centralized. Do not return or store the response accessToken; the API intentionally redacts it and sets the HttpOnly cookie.

- [ ] Step 4: Run the focused Web test and verify it passes.

Run the same command and confirm the request assertions pass with no raw credential in the ballot payload.

- [ ] Step 5: Commit the API helper slice.

    git add plus/apps/web/src/api/vote.ts plus/apps/web/src/api/vote.test.ts
    git commit -m "feat: add browser ticket redemption helper"

### Task 3: Implement the ticket voting page

Files:
- Modify: plus/apps/web/src/routes/vote.tsx
- Test: plus/apps/web/e2e/vote-page.spec.ts

Interfaces:
- Consume PublicVoteSession.ticketReady, redeemTicket, and ticket-aware submitVote from Tasks 1–2.
- URL format is /vote/<sessionId>#ticket=<credential>; the fragment is cleared before the redeem request.

- [ ] Step 1: Extend the E2E with a ticket-policy journey.

After the seed work in Task 4 is present, add a test that opens a formal ticket session, issues one ticket through the authenticated API, visits the vote URL with #ticket=..., selects alice, submits, reloads, and asserts “你已经投过票了。” The test must also assert the browser URL no longer contains ticket= after the exchange.

- [ ] Step 2: Run the ticket E2E and verify it fails.

    pnpm -C plus --filter @artflow-plus/web exec playwright test e2e/vote-page.spec.ts -g "ticket"

Expected: FAIL because the current page renders the ticket-blocked message and has no redemption flow.

- [ ] Step 3: Implement ticket page states.

Keep the current load/closed/browser/anonymous states. For an open ticket session with ticketReady = false, render a labelled credential input and “验证票据” button. Automatically populate the same mutation from a fragment credential, clear the fragment with replaceState, and prevent repeat auto-submit. After redemption invalidate the public-vote query. Render candidates only when the ticket is ready, and map invalid/replayed/expired/revoked ticket errors to the single safe message from the spec.

- [ ] Step 4: Run the ticket E2E and verify it passes.

Run the same Playwright command and confirm the full ticket path succeeds, including refresh recovery and URL scrubbing.

- [ ] Step 5: Run the existing browser vote E2E.

    pnpm -C plus --filter @artflow-plus/web exec playwright test e2e/vote-page.spec.ts -g "shared link"

Expected: the existing browser-identity journey remains green.

- [ ] Step 6: Commit the page slice.

    git add plus/apps/web/src/routes/vote.tsx plus/apps/web/e2e/vote-page.spec.ts
    git commit -m "feat: enable ticket-backed public voting"

### Task 4: Seed and prove a real ticket-backed formal activity

Files:
- Modify: plus/apps/api/scripts/seed-voting.ts
- Modify: plus/apps/web/e2e/vote-page.spec.ts

Interfaces:
- Add a seeded activity act_e2e_ticket_vote_page with voting + ticketing, a formal execution session, and a frozen voting artifact whose identity policy is ticket.
- On reseed, delete only this seed’s ticket_access_session and ticket rows before deleting ballots/options/sessions.

- [ ] Step 1: Add the seed fixture required by the failing E2E.

Parameterize the existing voting seed helper for identity policy and enabled capabilities; add the ticketing release artifact and the new activity without changing the current browser activities.

- [ ] Step 2: Run the focused seed plus E2E and confirm the failure is now the missing UI behavior.

    pnpm -C plus --filter @artflow-plus/api exec tsx scripts/seed-voting.ts
    pnpm -C plus --filter @artflow-plus/web exec playwright test e2e/vote-page.spec.ts -g "ticket"

Expected: seed succeeds; the E2E reaches the ticket page and fails on the absent redemption controls before production UI changes.

- [ ] Step 3: Keep the E2E authority checks explicit.

Issue the ticket via the logged-in Ops page request, pass only the returned credential in the fragment, submit through the page, reload, and verify a second submit is impossible because the read state is voted. Do not read the HttpOnly cookie from browser JavaScript.

- [ ] Step 4: Run the complete vote-page E2E file.

    pnpm -C plus --filter @artflow-plus/web exec playwright test e2e/vote-page.spec.ts

Expected: browser and ticket journeys pass together.

- [ ] Step 5: Commit the E2E fixture slice.

    git add plus/apps/api/scripts/seed-voting.ts plus/apps/web/e2e/vote-page.spec.ts
    git commit -m "test: cover ticket-backed voting journey"

### Task 5: Update the product contract and run Plus verification

Files:
- Modify: docs/artflow-plus/roadmap.md
- Modify: docs/artflow-plus/shape-validation.md
- Modify: plus/README.md
- Test: docs/configuration checks and Plus verification commands

- [ ] Step 1: Update the docs.

Mark the ticket-backed voting entry as delivered after the browser journey is green; document the fragment entry, HttpOnly exchange, public ticketReady field, and that raw credentials are never submitted with ballots. Remove only the ticket-entry gap, leaving account migration and other known gaps unchanged.

- [ ] Step 2: Run focused package checks.

    pnpm -C plus --filter @artflow-plus/contracts check
    pnpm -C plus --filter @artflow-plus/db check
    pnpm -C plus --filter @artflow-plus/runtime check
    pnpm -C plus --filter @artflow-plus/api check
    pnpm -C plus --filter @artflow-plus/web check
    pnpm -C plus --filter @artflow-plus/api exec vitest run test/public-vote.test.ts
    pnpm -C plus --filter @artflow-plus/web exec vitest run src/api/vote.test.ts
    pnpm -C plus --filter @artflow-plus/web exec playwright test e2e/vote-page.spec.ts

- [ ] Step 3: Run the Plus gates requested by the user.

    pnpm -C plus run check
    pnpm -C plus run test
    uv run pytest tests/gates -q
    pwsh -NoProfile -File scripts/check_docs.ps1

Do not run full Django tests or the real rehearsal. If the existing PostgreSQL acceptance setup is needed for the Plus test command, use the already-enabled Docker PostgreSQL service and leave its source volume intact.

- [ ] Step 4: Review configuration sweep and diff.

Check that no new TypeScript source is omitted from the existing tsconfig, no dependency/migration was added unnecessarily, and git diff --check is clean. Confirm the final diff contains no raw ticket credential literals or debug logging.

- [ ] Step 5: Commit and report evidence.

    git add docs/artflow-plus/roadmap.md docs/artflow-plus/shape-validation.md plus/README.md
    git commit -m "docs: close ticket-backed voting gap"
    git diff --check
    git status --short --branch

Report the exact focused test counts and gate results; do not claim completion without fresh command output.
