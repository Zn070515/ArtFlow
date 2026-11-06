# ADR-0028: The participant vote page

- **Status**: accepted
- **Date**: 2026-10-27

## Context

M10/M11 made vote sessions and result publishing operable for staff, but voters
only had a write-only ballot endpoint. There was no public read for candidates,
selection rules, identity policy, or the already-voted state.

## Decision

- Add `GET /api/public/vote/:sessionId`. It returns activity, title, session
  status, selection rules, identity policy, candidates, and `voted`; it never
  returns tallies or voter identities.
- Only `formal` sessions are public; rehearsal/test sessions return 404.
- The vote page is `/vote/<sessionId>` and follows the existing identity policy:
  browser (cookie), anonymous, or a clear ticket block.
- The already-voted state is derived from the same `stableHash(browser cookie)`
  digest the ballot command uses.
- Ops shares open formal sessions through a link, copy button, and client-side QR.

## Consequences

- Browser identity can be cleared; anonymity is a lightweight boundary, not a
  hard one-ballot-per-person guarantee.
- Ticket-policy sessions stay blocked until a ticket UI exists.
- The vote page does not poll; a session closed after load is discovered on submit.
