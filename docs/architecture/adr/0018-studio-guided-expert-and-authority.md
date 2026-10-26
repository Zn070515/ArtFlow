# ADR-0018: Studio guided/expert editing and mutation authority

- **Status**: accepted
- **Date**: 2026-10-26

## Decision

Studio uses one new permission, `studio.manage`. The engine mutations that Studio
drives — activity create, activate, definition compile, definition release,
execution start, and execution close — now derive the actor from the authenticated
request (`requestDeps`) and require `studio.manage`. They no longer use the base
or system actor. This closes the previously unauthenticated engine mutation gap.

`GET /api/activities` is available to `studio.manage` as well as the Ops
registration permissions. `GET /api/activities/:id/studio` returns the Studio
state: activity summary, current draft, the compiled plan for that exact draft
revision, release metadata, and execution sessions. It never returns full
compiled artifacts.

Studio's creation flow is Guided: an Activity Pack plus its guided questions
produces the initial Definition Package. The workspace exposes the raw package in
an Expert JSON editor; compile validates it through the normal capability
compilers and release freezes it. Editing is not a second write path: both Guided
creation and Expert editing end at the same compile/release commands.

Execution sessions are started and closed from Studio using the active release's
frozen `declaredScopes`. Live's on-site operation remains M8d.

## Alternatives rejected

- Separate `/api/studio/*` mutation routes would leave the old engine routes
  unauthenticated; the authority gap would persist.
- Role-only checks (`staff`/`admin`) conflict with the existing permission-first
  actor model.
- A second "guided" editor over an existing draft would imply activity
  capability changes that have no command; the draft package is the edit surface.

## Consequences

- Local accounts that use Studio must be granted `studio.manage`.
- API clients that previously created activities without authentication now need
  a session with `studio.manage`.
- The Studio state endpoint is read-only; no new tables or migrations.
- Expert editing can produce invalid packages; compile diagnostics are the
  authority and are surfaced verbatim by the web.
