# ADR-0019: Live console authority and capability judge entry

- **Status**: accepted
- **Date**: 2026-10-26

## Decision

The staff Live console reads one activity projection
(`GET /api/activities/:id/live`, `competition.manage` or `judge.manage`): activity
summary, the active release's competition artifact (`rounds`/`rubric`/`tiePolicy`),
the running `judging` session, per-round panel/seats/performances with current
score counts and ranking, and the final roster's approved participant IDs. It
never returns the full release. All mutations remain their existing commands;
`execution.start`/`execution.close` additionally accept `competition.manage`
alongside `studio.manage`.

A judge needs no local account. Staff reissue a signed judge capability under the
`ticketing` capability; the judge claims an entry seat (`judge_seat_grant`) and
receives an HttpOnly `artflow_judge_session`. `GET /api/judge/context` resolves
the session's entry seat **by seat key** to the member of the current panel and
then to that panel's competition `judge_seat`; the response carries the rubric,
the open performance, the scoring identifiers, and the judge's existing score
fact. A score written with `source=direct_judge` is attributed to the panel
member's `judgeId`, while the entry-seat binding authorizes the write.

Activating a panel creates idempotent claimable entry seats per seat key when the
activity enables `ticketing`, so the Live console can hand out links without a
separate provisioning command. SSE is an invalidation hint only; the console
falls back to 5-second polling, and `events`/`execution-state` stay the
authoritative recovery path.

`CompetitionScoreBodySchema` is one flat closed object. Fastify's AJV runs with
`removeAdditional`, so an `Intersect` of two closed objects silently stripped the
other side's properties before validation.

## Alternatives rejected

- Storing the capability or judge session token in browser storage: it would
  outlive the tab and contradict the HttpOnly cookie contract; the capability is
  removed from the address bar after the claim.
- Binding the judge session to a competition `judge_seat` id: seat ids change
  with every panel snapshot and reissue, so the session would break when staff
  reconfigure the panel. The seat key is the stable activity-level link.
- Letting the judge page choose panel/round/seat from client state: the authority
  must come from the server-resolved session.
- Disabling `removeAdditional` globally to keep the Intersect schema: it weakens
  validation on every route; flattening one schema is the smaller change.

## Consequences

- Judge links require the `ticketing` capability on the activity.
- A claimed entry seat is single-use for its `(activity, seat key)` until staff
  reissue; multi-round panels that reuse seat keys need an explicit reset command
  in a later slice.
- Direct judge scoring still requires a running `judging` execution session for
  the round's release.
- The judge page only supports the panel/current-performance model; staff drive
  round and performance transitions.
