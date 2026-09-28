# Event-Day UX Implementation Plan

> **For implementation:** execute inline in the repository checkout, without subagents or linked worktrees. Keep each logical change in a small conventional commit.

**Goal:** Make judge, audience-vote, and ticket-scan screens self-explanatory and safe on phones while preserving their existing authority and transport boundaries.

**Scope:** event templates, existing TypeScript/compiled client assets, and focused server/client/browser tests. No scoring, voting, ticket, or judge authority changes.

## Tasks

1. Add failing client/template tests for judge terminal status/error states and bounded decimal inputs, audience selection count/irreversible-submit confirmation, and ticket scan success/failure/manual fallback.
2. Improve judge terminal markup and client rendering for current contestant/status, input constraints, offline/error/retry states, and safe user-facing failure messages without exposing bearer credentials.
3. Improve audience voting markup and behavior with explicit selection limits/counts, disabled invalid submit, and a confirmation step that states submission is irreversible.
4. Improve ticket scan markup/client behavior with a manual secret-code fallback, clear success/failure states, and generic server failure handling. Keep secret scrubbing and body-only redemption.
5. Run focused client tests, TypeScript/client build gates, and existing Playwright contract tests when a service is intentionally available; then commit the independently verified change.

## Verification

- `npm run test:client`
- `npm run check:client`
- `npm run check:css`
- `python manage.py test singer_contest voting tickets`
- `npx playwright test tests/e2e/ticket-boundary.spec.ts tests/e2e/judge-flow.spec.ts`

## Self-review checklist

- Existing judge bearer-token, ticket body-only, rate-limit, and generic failure contracts remain unchanged.
- No client-side UI state is treated as authority; server responses remain authoritative.
- Decimal score limits come from server-provided context, not hard-coded client-only rules.
- Retry/confirmation flows cannot duplicate a vote or score submission.
