# Participant Account Claim and Legacy Identity Link Implementation Plan

> This repository requires inline execution by the primary agent; do not use
> subagents or linked worktrees. Steps use checkbox (`- [ ]`) syntax for
> tracking.

**Goal:** Let a staff-verified v1 participant claim an adopted Plus registration without rewriting its `legacy-user:<id>` authority or importing a v1 password.

**Architecture:** Add a one-time staff-issued claim capability and a one-to-one identity-alias table. Keep imported participant IDs immutable; runtime services resolve a local participant actor to its linked legacy subject before enforcing participant ownership. Use the existing receipt/audit/outbox command path, digest-only capability storage, HttpOnly session cookies, and fragment delivery for the raw claim token.

**Tech Stack:** Node 24, TypeScript, Fastify 5, TypeBox, Kysely/PostgreSQL, Vitest, React 19, TanStack Router/Query, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-28-participant-account-claim-design.md`

## Global Constraints

- Work inline on `feat/participant-account-claim`; do not spawn subagents or use a linked worktree.
- Do not delete or move the v1 source tree, change the cutover rollback boundary, or import v1 password hashes.
- Never rewrite `registration.participant_id`, grouping membership, material ownership, scores, votes, or archive facts.
- Raw claim tokens are returned only once, stored only as SHA-256 digests, omitted from receipts/audit/outbox/logs, and delivered to the browser through a URL fragment or manual input.
- Claim identity links are one-to-one: one `legacy-user:<id>` maps to one Plus participant actor, and one Plus participant actor maps to one legacy identity.
- All accepted writes use `executeCommand`; receipt, audit, fact, and outbox event commit in one transaction, and `Idempotency-Key` is mandatory.
- Public invalid-claim responses use `INVALID_PARTICIPANT_CLAIM` without revealing whether an identity or account exists.
- Production uses the existing credential/session configuration; no new secret or external identity provider is introduced.
- Verification uses focused Plus DB/runtime/API/Web tests, `pnpm -C plus run check`, and the requested Plus test gate; do not run the v1 full suite.

---

### Task 1: Persist claims, identity links, and the domain error

**Files:**
- Modify: `plus/packages/domain/src/errors.ts`
- Modify: `plus/packages/db/src/types.ts`
- Modify: `plus/packages/db/src/migrations.ts`
- Test: `plus/packages/db/test/migrations.test.ts`

**Interfaces:**
- Produces `DomainErrorCode` member `INVALID_PARTICIPANT_CLAIM`.
- Produces `ParticipantClaimRow` and `ParticipantIdentityLinkRow` in the DB type map.
- Produces migration `0019_participant_account_claim`.

- [ ] **Step 1: Write the failing migration contract test**

Add a test to `migrations.test.ts` that migrates to the latest version and
asserts the two tables, required indexes, and uniqueness constraints. Use the
same `migrate(db)`/`migrateTo(db, name)` helpers already used by the file:

```ts
it("creates participant claim and identity-link tables", async () => {
  await migrate(db);
  const tables = await sql<{ table_name: string }>`
    select table_name
      from information_schema.tables
     where table_schema = current_schema()
       and table_name in ('participant_claim', 'participant_identity_link')
     order by table_name
  `.execute(db);
  expect(tables.rows.map((row) => row.table_name)).toEqual([
    "participant_claim",
    "participant_identity_link",
  ]);

  const indexes = await sql<{ indexname: string }>`
    select indexname
      from pg_indexes
     where schemaname = current_schema()
       and indexname in (
         'participant_claim_token_digest_key',
         'participant_claim_registration_idx',
         'participant_identity_link_actor_key'
       )
     order by indexname
  `.execute(db);
  expect(indexes.rows.map((row) => row.indexname)).toEqual([
    "participant_claim_registration_idx",
    "participant_claim_token_digest_key",
    "participant_identity_link_actor_key",
  ]);
});
```

- [ ] **Step 2: Run the migration test to verify it fails**

Run:

```powershell
pnpm -C plus --filter @artflow-plus/db exec vitest run test/migrations.test.ts
```

Expected: FAIL because the new tables and indexes do not exist.

- [ ] **Step 3: Add the error code and row types**

Add `INVALID_PARTICIPANT_CLAIM` to `DomainErrorCode`. In `db/src/types.ts`, add:

```ts
export interface ParticipantClaimRow {
  id: string;
  activity_id: string;
  registration_id: string;
  legacy_participant_id: string;
  token_digest: string;
  expires_at: ColumnType<Date, Date | string, Date | string>;
  consumed_at: ColumnType<Date | null, Date | string | null, Date | string | null>;
  consumed_by_actor_id: string | null;
  issued_by: string;
  created_at: ColumnType<Date, Date | undefined, never>;
}

export interface ParticipantIdentityLinkRow {
  legacy_participant_id: string;
  actor_id: string;
  linked_at: ColumnType<Date, Date | string, Date | string>;
  linked_by: string;
  claim_id: string;
}
```

Add `participant_claim` and `participant_identity_link` to `Database`.

- [ ] **Step 4: Add migration `0019_participant_account_claim`**

Create `participant_claim` first so `participant_identity_link.claim_id` can
reference it, then create the link table. Use the existing Kysely migration
style and constraints:

```ts
"0019_participant_account_claim": {
  async up(db) {
    await db.schema.createTable("participant_claim")
      .addColumn("id", "varchar(100)", (column) => column.primaryKey())
      .addColumn("activity_id", "varchar(100)", (column) => column.notNull().references("activity.id").onDelete("cascade"))
      .addColumn("registration_id", "varchar(100)", (column) => column.notNull().references("registration.id").onDelete("cascade"))
      .addColumn("legacy_participant_id", "varchar(100)", (column) => column.notNull())
      .addColumn("token_digest", "varchar(64)", (column) => column.notNull())
      .addColumn("expires_at", "timestamptz", (column) => column.notNull())
      .addColumn("consumed_at", "timestamptz")
      .addColumn("consumed_by_actor_id", "varchar(100)")
      .addColumn("issued_by", "varchar(100)", (column) => column.notNull())
      .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
      .addUniqueConstraint("participant_claim_token_digest_key", ["token_digest"])
      .addCheckConstraint("participant_claim_legacy_id_check", sql`legacy_participant_id like 'legacy-user:%'`)
      .addCheckConstraint(
        "participant_claim_consumed_pair_check",
        sql`(consumed_at is null and consumed_by_actor_id is null) or (consumed_at is not null and consumed_by_actor_id is not null)`,
      )
      .execute();
    await db.schema.createIndex("participant_claim_registration_idx")
      .on("participant_claim").columns(["activity_id", "registration_id"]).execute();
    await db.schema.createTable("participant_identity_link")
      .addColumn("legacy_participant_id", "varchar(100)", (column) => column.primaryKey())
      .addColumn("actor_id", "varchar(100)", (column) => column.notNull())
      .addColumn("linked_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
      .addColumn("linked_by", "varchar(100)", (column) => column.notNull())
      .addColumn("claim_id", "varchar(100)", (column) => column.notNull().references("participant_claim.id").onDelete("restrict"))
      .addUniqueConstraint("participant_identity_link_actor_key", ["actor_id"])
      .addCheckConstraint("participant_identity_link_legacy_id_check", sql`legacy_participant_id like 'legacy-user:%'`)
      .execute();
  },
  async down(db) {
    await db.schema.dropTable("participant_identity_link").ifExists().execute();
    await db.schema.dropTable("participant_claim").ifExists().execute();
  },
},
```

- [ ] **Step 5: Run the migration tests and commit**

Run:

```powershell
pnpm -C plus --filter @artflow-plus/db exec vitest run test/migrations.test.ts
git add plus/packages/domain/src/errors.ts plus/packages/db/src/types.ts plus/packages/db/src/migrations.ts plus/packages/db/test/migrations.test.ts
git commit -m "feat: add participant claim persistence"
```

Expected: migration tests pass and the commit contains only the schema/error
contract.

### Task 2: Add repositories and database-backed identity resolution

**Files:**
- Create: `plus/packages/db/src/participant-account-repository.ts`
- Modify: `plus/packages/db/src/registration-repository.ts`
- Modify: `plus/packages/db/src/index.ts`
- Create: `plus/packages/runtime/src/participant-identity.ts`
- Modify: `plus/packages/runtime/src/index.ts`
- Test: `plus/packages/db/test/participant-account-repository.test.ts`
- Test: `plus/packages/runtime/test/participant-identity.test.ts`

**Interfaces:**
- `StoredParticipantClaim` maps the claim row to camelCase.
- `StoredParticipantIdentityLink` maps the identity link row to camelCase.
- `insertParticipantClaim(trx, value)`, `getParticipantClaimByDigestForUpdate(trx, digest)`, `markParticipantClaimConsumed(trx, id, consumedAt, actorId)`.
- `getParticipantIdentityLinkByLegacy(db, legacyId)`, `getParticipantIdentityLinkByLegacyForUpdate(trx, legacyId)`, `getParticipantIdentityLinkByActor(db, actorId)`, `insertParticipantIdentityLink(trx, value)`.
- `participantSubjectIds(db, actor): Promise<readonly string[]>` always includes `actor.actorId` and adds the linked legacy ID when present.
- `canActForParticipant(db, actor, participantId, permission): Promise<boolean>` returns true for a matching subject or a matching permission.
- `requireParticipantOwnership(db, actor, participantId, permission, message): Promise<void>` throws `FORBIDDEN` otherwise.

- [ ] **Step 1: Write repository tests for digest lookup and one-to-one links**

Create isolated PostgreSQL tests that insert a claim and link, assert the
camelCase result, assert `FOR UPDATE` lookup returns the row, and assert both
duplicate token digest and duplicate actor/legacy link inserts fail.

- [ ] **Step 2: Run the repository tests to verify they fail**

Run:

```powershell
pnpm -C plus --filter @artflow-plus/db exec vitest run test/participant-account-repository.test.ts
```

Expected: FAIL because the repository module and functions do not exist.

- [ ] **Step 3: Implement the repository module**

Follow `material-check-repository.ts` for JSON/date mapping and use a
transaction for all mutators. Never add a repository function that returns the
raw token; repository inputs contain only `tokenDigest`.

- [ ] **Step 4: Add participant-subject lookup**

Implement the runtime helper with the DB link repository. Staff permissions
must short-circuit authorization, but the returned subject list must remain
limited to the actor ID and its one linked legacy ID. Do not change the domain
package or import Kysely into it.

- [ ] **Step 5: Add registration lookup for multiple subjects**

Add `getRegistrationByParticipants(db, activityId, participantIds)` to
`registration-repository.ts`; use `where("participant_id", "in", [...])` and
return the deterministic first row ordered by `id`. This lets `getMyRegistration`
find an imported legacy registration without rewriting its ID.

- [ ] **Step 6: Run DB/runtime tests and commit**

Run:

```powershell
pnpm -C plus --filter @artflow-plus/db exec vitest run test/participant-account-repository.test.ts test/registration-repository.test.ts
pnpm -C plus --filter @artflow-plus/runtime exec vitest run test/participant-identity.test.ts
git add plus/packages/db/src/participant-account-repository.ts plus/packages/db/src/registration-repository.ts plus/packages/db/src/index.ts plus/packages/runtime/src/participant-identity.ts plus/packages/runtime/src/index.ts plus/packages/db/test/participant-account-repository.test.ts plus/packages/runtime/test/participant-identity.test.ts
git commit -m "feat: resolve linked participant identities"
```

### Task 3: Implement claim issue and consumption in the runtime

**Files:**
- Create: `plus/packages/runtime/src/participant-claim-service.ts`
- Modify: `plus/packages/runtime/src/index.ts`
- Test: `plus/packages/runtime/test/participant-claim-service.test.ts`

**Interfaces:**
- `IssueParticipantClaimInput { commandId, activityId, registrationId, ttlMs? }`.
- `IssuedParticipantClaim { token: string | null, activityId, publicCode, title, expiresAt }`.
- `issueParticipantClaim(db, deps, input): Promise<CommandOutcome<IssuedParticipantClaim>>`.
- `ConsumeParticipantClaimInput { commandId, token, username?, password? }`.
- `ConsumedParticipantClaim { actor: Omit<ActorContext, "authContext">, sessionToken?: string, expiresAt?: string }`; the API derives the CSRF token from the returned session token with its existing session secret.
- `consumeParticipantClaim(db, deps, input): Promise<CommandOutcome<ConsumedParticipantClaim>>`.

- [ ] **Step 1: Write failing runtime tests**

Cover these cases with deterministic `deps.now` and a PostgreSQL test fixture:

```ts
it("issues a digest-only claim for an adopted legacy registration", async () => {
  const outcome = await issueParticipantClaim(db, staffDeps, {
    commandId: "claim-issue-1",
    activityId: activityId,
    registrationId: registrationId,
  });
  expect(outcome.body.token).toMatch(/^AF1\.CLAIM\./);
  const row = await db.selectFrom("participant_claim").selectAll().executeTakeFirstOrThrow();
  expect(row.token_digest).not.toContain(outcome.body.token as string);
});

it("creates one local account and links it to the imported participant", async () => {
  const issued = await issueParticipantClaim(db, staffDeps, issueInput("claim-issue-2"));
  const consumed = await consumeParticipantClaim(db, publicDeps, {
    commandId: "claim-consume-1",
    token: issued.body.token as string,
    username: "legacy-claim-user",
    password: "claim-password-123",
  });
  expect(consumed.body.actor.actorId).toMatch(/^participant:/);
  expect(consumed.body.sessionToken).toBeTruthy();
  expect(await getRegistrationByParticipant(db, activityId, "legacy-user:1")).not.toBeNull();
});
```

Also cover non-legacy issuance, missing/expired/consumed claim, malformed
activity/registration pair, username conflict without consumption, existing
session claim, duplicate actor/legacy link, same-command replay, and two
concurrent consumers where only one creates the link.

- [ ] **Step 2: Run the runtime tests to verify they fail**

Run:

```powershell
pnpm -C plus --filter @artflow-plus/runtime exec vitest run test/participant-claim-service.test.ts
```

Expected: FAIL because the service has not been implemented.

- [ ] **Step 3: Implement staff issuance**

Resolve the registration and activity inside `executeCommand` and take the
activity/registration locks before checking that the activity is active, the
registration belongs to that activity, the participant ID starts with
`legacy-user:`, and no existing identity link exists. Generate
`AF1.CLAIM.<id>.<randomBytes(24).toString("base64url")>`, store only
`stableHash(token)`, and return the token only in the first in-memory response.
Use `persistedBody: { ...body, token: null }` so the receipt cannot contain the
credential. Emit `ParticipantAccountClaimIssued` with only claim ID,
registration ID, and legacy participant ID.

- [ ] **Step 4: Implement locked consumption**

Hash the supplied token, lock the claim row, re-check expiry and the exact
registration/activity relationship, then lock the existing identity link for
the legacy ID before choosing the actor. If `deps.actor` is an authenticated
participant actor, use it and reject any username/password fields. If there is
no authenticated actor, validate the username/password with the existing
participant rules, call `createLocalAccount(trx, ...)`, and then
`authenticateLocalAccount(trx, ...)` so the account and session are in the same
transaction. Require an authenticated actor to have the participant role; a
staff or other non-participant session cannot be used for this path.

Insert the identity link, mark the claim consumed, and append
`ParticipantAccountClaimed`. For an unauthenticated claim, use a deterministic
synthetic command actor derived from the command ID (for example,
`participant-claim:<commandId>`) in the command metadata; never use a request
body value as an actor. Build the returned actor by removing `authContext` from
the authenticated session/account result, and make the command payload use only
the token digest and non-secret username metadata; never put the raw claim
token or password in a receipt, audit detail, or outbox payload. Persist a
redacted response with `sessionToken: null` and no actor auth context. A replay
returns the redacted receipt and does not issue a second session or account.

- [ ] **Step 5: Run the runtime tests and commit**

Run:

```powershell
pnpm -C plus --filter @artflow-plus/runtime exec vitest run test/participant-claim-service.test.ts test/participant-identity.test.ts
git add plus/packages/runtime/src/participant-claim-service.ts plus/packages/runtime/src/index.ts plus/packages/runtime/test/participant-claim-service.test.ts
git commit -m "feat: add participant account claim service"
```

### Task 4: Apply linked identity authorization to registration and materials

**Files:**
- Modify: `plus/packages/runtime/src/registration-service.ts`
- Modify: `plus/packages/runtime/src/registration-read-service.ts`
- Modify: `plus/packages/runtime/src/material-service.ts`
- Test: `plus/packages/runtime/test/registration-service.test.ts`
- Create: `plus/packages/runtime/test/registration-read-service.test.ts`
- Create: `plus/packages/runtime/test/participant-material-authorization.test.ts`

**Interfaces:**
- All participant ownership checks call `canActForParticipant` or `requireParticipantOwnership`.
- Staff permission checks remain unchanged and still bypass subject matching.

- [ ] **Step 1: Add failing authorization regressions**

Seed a registration with `participant_id = "legacy-user:1"`, link it to a local
participant actor, then assert the linked actor can:

```ts
expect((await getMyRegistration(db, linkedDeps, activityId))?.participantId)
  .toBe("legacy-user:1");
await saveRegistrationAnswer(db, linkedDeps, answerInputFor("legacy-user:1"));
await uploadMaterial(db, linkedDeps, materialInputFor("legacy-user:1"));
```

Assert an unrelated participant receives `FORBIDDEN` for detail, answer,
submit, material upload, material content attach, and material read. Assert
staff still succeeds.

- [ ] **Step 2: Run the regressions to verify they fail**

Run:

```powershell
pnpm -C plus --filter @artflow-plus/runtime exec vitest run test/registration-service.test.ts test/registration-read-service.test.ts test/participant-material-authorization.test.ts
```

Expected: FAIL because services compare only literal actor IDs.

- [ ] **Step 3: Replace ownership checks with the runtime resolver**

Make `requireOwnerOrManager` asynchronous and pass `db` into it. Update
registration mine/detail, answer, submit, and all material ownership/read
checks. For content attach, preserve the existing staff bypass and compare the
actor against resolved participant subjects before allowing the storage write.
Do not alter `owner_actor_id` on existing material rows; newly uploaded rows
may continue to record the local actor ID while the registration remains
legacy-owned.

- [ ] **Step 4: Run authorization tests and commit**

Run:

```powershell
pnpm -C plus --filter @artflow-plus/runtime exec vitest run test/registration-service.test.ts test/registration-read-service.test.ts test/participant-material-authorization.test.ts
git add plus/packages/runtime/src/registration-service.ts plus/packages/runtime/src/registration-read-service.ts plus/packages/runtime/src/material-service.ts plus/packages/runtime/test/registration-service.test.ts plus/packages/runtime/test/registration-read-service.test.ts plus/packages/runtime/test/participant-material-authorization.test.ts
git commit -m "fix: authorize linked legacy participants"
```

### Task 5: Expose the claim flow through the API

**Files:**
- Create: `plus/packages/contracts/src/participant-claim.ts`
- Modify: `plus/packages/contracts/src/index.ts`
- Modify: `plus/apps/api/src/app.ts`
- Create: `plus/apps/api/test/participant-claim.test.ts`

**Interfaces:**
- `ParticipantClaimConsumeBodySchema` validates `token` plus optional
  `username`/`password` and rejects additional properties.
- `POST /api/activities/:id/registrations/:registrationId/account-claim` uses
  `Idempotency-Key`, staff session, and returns the issued claim.
- `POST /api/public/participant-claims/consume` uses `Idempotency-Key`, public
  rate limiting, optional current session, and returns a redacted actor body.

- [ ] **Step 1: Write failing API tests**

Use the existing Fastify `app.inject` helpers and PostgreSQL fixture. Cover:

```ts
it("returns a claim token only on the first staff response", async () => {
  const first = await app.inject({
    method: "POST",
    url: `/api/activities/${activityId}/registrations/${registrationId}/account-claim`,
    headers: { authorization: `Bearer ${staffToken}`, "idempotency-key": "claim-issue-api-1" },
    payload: {},
  });
  expect(first.statusCode).toBe(201);
  expect(first.json().token).toMatch(/^AF1\.CLAIM\./);

  const replay = await app.inject({
    method: "POST",
    url: `/api/activities/${activityId}/registrations/${registrationId}/account-claim`,
    headers: { authorization: `Bearer ${staffToken}`, "idempotency-key": "claim-issue-api-1" },
    payload: {},
  });
  expect(replay.statusCode).toBe(201);
  expect(replay.json().token).toBeNull();
});
```

Also cover public claim creation and cookie flags, existing-session claim with
CSRF, invalid-token generic response, rate limit, username conflict preserving
the grant, and no token in receipt/audit/outbox JSON.

- [ ] **Step 2: Run the API tests to verify they fail**

Run:

```powershell
pnpm -C plus --filter @artflow-plus/api exec vitest run test/participant-claim.test.ts
```

Expected: FAIL because the contract and routes do not exist.

- [ ] **Step 3: Add TypeBox contracts and error mapping**

Create the consume schema:

```ts
export const ParticipantClaimConsumeBodySchema = Type.Object(
  {
    token: Type.String({ minLength: 1, maxLength: 300 }),
    username: Type.Optional(Type.String({ minLength: 3, maxLength: 64, pattern: "^[A-Za-z0-9_.-]+$" })),
    password: Type.Optional(Type.String({ minLength: 8, maxLength: 128 })),
  },
  { additionalProperties: false },
);
```

Add `INVALID_PARTICIPANT_CLAIM: 400` to `STATUS_BY_CODE` and export the schema.

- [ ] **Step 4: Add staff issuance route**

Register the route with `ActivityParams`/`RegistrationParams`, require an
operations actor through `requestDeps`, call `issueParticipantClaim`, set
`cache-control: no-store`, and send the outcome. The request body is `{}` with
`additionalProperties: false`; `requireIdempotency(request)` supplies the
command ID.

- [ ] **Step 5: Add public consumption route**

Call `requestSession(request)` without forcing authentication. Pass
`session?.actor` explicitly into runtime deps; do not let `SYSTEM_ACTOR` become
the participant actor. Rate-limit by IP at 10/minute, call
`consumeParticipantClaim`, and on a first successful new-account result set the
normal `artflow_session` and `artflow_csrf` cookies using the existing helper.
The JSON response must omit `sessionToken`, set `cache-control: no-store`, and
return only the actor without `authContext`, `csrfToken` when available, and
`expiresAt`.

- [ ] **Step 6: Run API tests and commit**

Run:

```powershell
pnpm -C plus --filter @artflow-plus/api exec vitest run test/participant-claim.test.ts test/auth.test.ts
git add plus/packages/contracts/src/participant-claim.ts plus/packages/contracts/src/index.ts plus/apps/api/src/app.ts plus/apps/api/test/participant-claim.test.ts
git commit -m "feat: expose participant account claim API"
```

### Task 6: Add participant claim UI and the staff issuance action

**Files:**
- Create: `plus/apps/web/src/api/participantClaim.ts`
- Create: `plus/apps/web/src/routes/claim.tsx`
- Modify: `plus/apps/web/src/router.tsx`
- Modify: `plus/apps/web/src/api/ops.ts`
- Modify: `plus/apps/web/src/routes/opsRegistration.tsx`
- Modify: `plus/apps/web/src/styles/global.css`
- Test: `plus/apps/web/src/api/participantClaim.test.ts`
- Test: `plus/apps/web/src/routes/claim.test.tsx`

**Interfaces:**
- `issueParticipantClaim(activityId, registrationId, commandId)` returns the
  staff DTO with `token: string | null`.
- `consumeParticipantClaim(token, commandId, credentials?)` posts the public
  DTO with `credentials: "same-origin"` through `apiFetch`.
- `/claim` reads an initial token from `window.location.hash`, then immediately
  calls `history.replaceState` to remove it from the address bar.

- [ ] **Step 1: Write failing API/UI tests**

Assert the API client sends the token in JSON, uses a fresh idempotency key, and
does not put it in the path. Assert the claim page accepts a fragment token,
clears the fragment, submits credentials, and navigates to `/join/E2E-REG` after
success. Assert missing/invalid token and password validation are visible.

- [ ] **Step 2: Run Web tests to verify they fail**

Run:

```powershell
pnpm -C plus --filter @artflow-plus/web exec vitest run src/api/participantClaim.test.ts src/routes/claim.test.tsx
```

Expected: FAIL because the client and route do not exist.

- [ ] **Step 3: Implement the API client and claim page**

Use the existing `apiFetch`, session cookies, and form style. If a session is
already present, omit username/password and let the API bind that actor. For a
new account require matching password and confirmation in the browser. Never
render the raw token after the submit attempt; keep it only in component state
until the request completes.

- [ ] **Step 4: Add the Ops action**

Add an “生成参与者认领链接” button when the registration participant ID
starts with `legacy-user:`. The API remains the final guard for an already
linked legacy identity. On success, build
`${window.location.origin}/claim#${encodeURIComponent(token)}` and show a copy
button plus expiry. If the API returns `token: null`, explain that the prior
one-time response was already replayed and a new idempotency key is required;
never fabricate a link.

- [ ] **Step 5: Run Web tests and commit**

Run:

```powershell
pnpm -C plus --filter @artflow-plus/web exec vitest run src/api/participantClaim.test.ts src/routes/claim.test.tsx src/components/form/QuestionField.test.tsx
git add plus/apps/web/src/api/participantClaim.ts plus/apps/web/src/routes/claim.tsx plus/apps/web/src/router.tsx plus/apps/web/src/api/ops.ts plus/apps/web/src/routes/opsRegistration.tsx plus/apps/web/src/styles/global.css plus/apps/web/src/api/participantClaim.test.ts plus/apps/web/src/routes/claim.test.tsx
git commit -m "feat: add participant claim web flow"
```

### Task 7: Add a browser journey for an adopted legacy participant

**Files:**
- Modify: `plus/apps/api/scripts/seed-registration.ts`
- Create: `plus/apps/web/e2e/participant-account-claim.spec.ts`

**Interfaces:**
- The seed adds a deterministic adopted-style registration with
  `participant_id = "legacy-user:e2e"` and no local account.
- The E2E uses separate Ops and participant browser contexts.

- [ ] **Step 1: Extend the seed with a legacy registration**

Before deleting the seeded activity rows, delete claim rows for the activity and
delete identity links whose `claim_id` belongs to those claims. Then insert a
submitted legacy registration with known answers and no material rows. Keep the
existing self-registration fixture unchanged so the current journey remains a
regression test.

- [ ] **Step 2: Write the failing browser journey**

Create a Playwright test that logs into Ops, opens the `legacy-user:e2e`
registration, issues a claim, reads the returned fragment link from the UI,
opens it in a fresh participant context, creates a new account, and asserts:

```ts
await expect(participant).toHaveURL(/\/join\/E2E-REG$/);
await expect(participant.getByText("legacy-user:e2e")).toBeVisible();
```

Then reload the join page and assert the imported answers are readable through
the new session. The test must also assert that a second use of the same claim
fails closed.

- [ ] **Step 3: Run the E2E type check and journey**

Run:

```powershell
pnpm -C plus --filter @artflow-plus/web exec tsc -p tsconfig.json --noEmit
pnpm -C plus --filter @artflow-plus/web exec playwright test e2e/participant-account-claim.spec.ts --workers=1
```

Expected: the journey passes against the existing local Plus API/Web setup and
the separate E2E PostgreSQL schema.

- [ ] **Step 4: Commit the browser evidence**

```powershell
git add plus/apps/api/scripts/seed-registration.ts plus/apps/web/e2e/participant-account-claim.spec.ts
git commit -m "test: cover legacy participant account claim"
```

### Task 8: Update documentation and run the focused Plus verification

**Files:**
- Create: `docs/architecture/adr/0034-participant-account-claim.md`
- Modify: `docs/artflow-plus/roadmap.md`
- Modify: `plus/README.md`
- Modify: `docs/artflow-plus/shape-validation.md`
- Test/verification: no new source file; use the focused commands below.

- [ ] **Step 1: Write the ADR**

Record the accepted identity-alias decision, staff verification requirement,
no-password-migration rule, one-to-one mapping, fragment delivery, and the
fact that imported participant IDs remain authoritative. Explicitly state that
this slice does not authorize deletion of v1 source or media.

- [ ] **Step 2: Update roadmap and gap tables**

Mark participant account claim/migration as completed with the API/runtime/Web
and browser evidence. Remove it from the remaining product-gap list while
leaving the public program page, bracket/composite scoring, XLSX export, on-site
display, and multi-instance realtime items unchanged. Update shape validation to
describe the claim link rather than implying imported participants can never log
in.

- [ ] **Step 3: Run focused verification**

Run:

```powershell
pnpm -C plus --filter @artflow-plus/db exec vitest run test/migrations.test.ts test/participant-account-repository.test.ts test/registration-repository.test.ts
pnpm -C plus --filter @artflow-plus/domain exec vitest run test/auth.test.ts
pnpm -C plus --filter @artflow-plus/runtime exec vitest run test/participant-identity.test.ts test/participant-claim-service.test.ts test/registration-service.test.ts test/registration-read-service.test.ts test/participant-material-authorization.test.ts
pnpm -C plus --filter @artflow-plus/api exec vitest run test/participant-claim.test.ts test/auth.test.ts test/registration-read.test.ts
pnpm -C plus --filter @artflow-plus/web exec vitest run src/api/participantClaim.test.ts src/routes/claim.test.tsx
pnpm -C plus run check
pnpm -C plus run test
uv run pytest tests/gates -q
git diff --check
```

Expected: all focused suites and the Plus gates pass; the v1 suite is not run.

- [ ] **Step 4: Final review and commit**

Review the diff for raw token leakage, direct participant-ID comparisons that
remain outside the resolver, missing CSRF behavior, and accidental v1 changes.
Then commit documentation separately:

```powershell
git add docs/architecture/adr/0034-participant-account-claim.md docs/artflow-plus/roadmap.md plus/README.md docs/artflow-plus/shape-validation.md
git commit -m "docs: record participant account claim"
git status --short --branch
```

The branch is ready for the normal review/merge workflow only when the final
status is clean and every command above has fresh passing output.
