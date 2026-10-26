# M8b Registration Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the participant registration loop and the Ops review/roster loop behind cookie+CSRF auth.

**Architecture:** Add HttpOnly session cookies, session-bound CSRF, participant self-registration, and read endpoints for the released questionnaire and registrations. Extend `apps/web` with login, public-code join, form, and Ops review pages. Materials remain metadata-only; no byte storage.

**Spec:** `docs/artflow-plus/specs/2026-10-26-m8b-registration-loop-design.md`

---

### Task 1: Auth session, CSRF, participant registration

**Files:**
- Modify: `plus/packages/runtime/src/auth-service.ts`
- Modify: `plus/packages/domain/src/errors.ts`
- Create: `plus/packages/contracts/src/registration.ts`
- Modify: `plus/packages/contracts/src/index.ts`
- Modify: `plus/apps/api/src/app.ts`
- Test: `plus/apps/api/test/auth.test.ts`

- [ ] **Step 1: Runtime helpers**

In `auth-service.ts` add `createHmac`/`randomUUID` imports and:

```ts
export function csrfTokenFor(sessionToken: string, secret: string): string {
  return createHmac("sha256", secret).update(`csrf:${sessionToken}`).digest("hex");
}

export async function resolveLocalSession(
  db: Kysely<Database>, token: string, now: string,
): Promise<StoredLocalSession | null> {
  return getLocalSession(db, token, now);
}

export async function registerParticipantAccount(
  db: Kysely<Database>,
  input: { readonly username: string; readonly password: string },
): Promise<{ readonly token: string; readonly actor: ActorContext; readonly expiresAt: string }> {
  // validate username 3-64 [A-Za-z0-9_.-], password 8-128
  // createLocalAccount with actorId `participant:${randomUUID()}`, roles ["participant"], permissions []
  // pg 23505 -> DomainError("USERNAME_TAKEN")
  // then authenticateLocalAccount
}
```

Create `contracts/src/registration.ts` with `RegisterParticipantBodySchema`
(`username`, `password`) and export it from the contracts index.

- [ ] **Step 2: Error codes and status map**

Add `CSRF_INVALID`, `USERNAME_TAKEN`; HTTP 403/409.

- [ ] **Step 3: Cookies and CSRF hook in `app.ts`**

```ts
const sessionSecret = deps.credentialSecret ?? process.env.ARTFLOW_PLUS_CREDENTIAL_SECRET ?? "artflow-plus-development-secret";
const secureCookie = process.env.NODE_ENV === "production" || process.env.APP_ENV === "production" ? "; Secure" : "";

function setSessionCookies(reply, token, csrf): void {
  reply.header("set-cookie", [
    `artflow_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800${secureCookie}`,
    `artflow_csrf=${csrf}; Path=/; SameSite=Strict; Max-Age=28800${secureCookie}`,
  ]);
}
```

`app.addHook("onRequest", ...)` as specified: skip GET/HEAD/OPTIONS, Bearer, login/register/logout; if session cookie present require `x-csrf-token === csrfTokenFor(token, sessionSecret)`.
If production is configured and neither `deps.credentialSecret` nor
`ARTFLOW_PLUS_CREDENTIAL_SECRET` is set, throw at startup instead of using the dev
fallback.

`requestActor` uses `cookieValue(request,"artflow_session") ?? bearerToken(request)`.

- [ ] **Step 4: Auth routes**

- login: authenticate, compute csrf, set cookies, return `{token, actor, csrfToken, expiresAt}`.
- register: rate limit 5/min, register, csrf, cookies, return.
- me: cookie/bearer session → `{actor, csrfToken, expiresAt}`.
- logout: read session token, `revokeLocalSession`, clear cookies with
  `Max-Age=0` (both `artflow_session` and `artflow_csrf`), return `{ok:true}`.

- [ ] **Step 5: Tests**

Cookie flags; me; logout; register/duplicate; CSRF missing/valid; Bearer bypass.

- [ ] **Step 6: Commit** `feat(auth): add cookie sessions and participant registration`.

---

### Task 2: Read endpoints for activities, registrations, roster

**Files:**
- Modify: `plus/packages/db/src/activity-repository.ts`
- Create: `plus/packages/runtime/src/registration-read-service.ts`
- Modify: `plus/packages/runtime/src/index.ts`
- Modify: `plus/apps/api/src/app.ts`
- Test: `plus/apps/api/test/registration-read.test.ts`

- [ ] **Step 1: DB summaries**

```ts
export interface StoredActivitySummary { id; publicCode; title; status; revision; enabledCapabilities }
listActivities(db): Promise<readonly StoredActivitySummary[]>
getActivityByPublicCode(db, code): Promise<StoredActivitySummary | null>
```

- [ ] **Step 2: Runtime read service**

```ts
getPublicActivity(db, publicCode) // {id, publicCode, title, status, registrationOpen}
listActivitiesForOps(db, deps) // hasPermission(review) || hasPermission(manage)
getMyRegistration(db, deps, activityId)
getRegistrationDetail(db, deps, activityId, registrationId)
  // actor.actorId === participantId || review || manage
listRegistrationsForReview(db, deps, activityId) // review || manage
getRosterForReview(db, deps, activityId) // review || roster.finalize
```

DTO exactly as the spec. Read materials via `listMaterials`; questionnaire via
`findReleaseByQuestionnaireHash`; no schemaHash/fingerprint/storageKey/ownerActorId
in the response.

- [ ] **Step 3: Routes**

Add the six routes from the spec; register `registrations/mine` before
`registrations/:registrationId`. Staff routes call the service permissions.

- [ ] **Step 4: Tests**

Public activity; list permission; mine 404/owner; detail owner vs outsider vs reviewer;
list; roster; no fingerprint/schemaHash in JSON.

- [ ] **Step 5: Commit** `feat(registration): add participant and ops read endpoints`.

---

### Task 3: Web API client, session, login/register, shell nav

**Files:**
- Create: `plus/apps/web/src/api/{client,auth}.ts`
- Create: `plus/apps/web/src/auth/{SessionProvider,RequireSession}.tsx`
- Create: `plus/apps/web/src/routes/login.tsx`
- Modify: `plus/apps/web/src/{main,router}.tsx`, `routes/__root.tsx`, `styles/global.css`
- Tests: `src/api/client.test.ts`, `src/api/auth.test.ts`

- [ ] **Step 1: `apiFetch`**

Add `ApiError` (status/code/message), `csrfFromCookie()` reading `artflow_csrf`;
mutations add `x-csrf-token`; always `credentials: "same-origin"`; 204 handling.

- [ ] **Step 2: Auth API**

`login`, `register`, `logout`, `me` (401 → null in the provider).

- [ ] **Step 3: Session provider + guard**

`SessionProvider` with TanStack Query `["me"]`; `useSession`; login/register/logout
invalidate. `RequireSession` redirects to `/login?next=<path>` when null.

- [ ] **Step 4: Login/register page**

Two-mode form; confirm password on register; show API error messages; after success
navigate to `next` only when it starts with `/` and not `//` (open-redirect guard),
otherwise `/join`.

- [ ] **Step 5: Shell nav**

Header shows 登录 or actor + 退出 + Ops (if `registration.review`/`manage`).

- [ ] **Step 6: Tests + commit**.

---

### Task 4: Participant join and form

**Files:**
- Create: `plus/apps/web/src/routes/{join,joinActivity}.tsx`
- Create: `plus/apps/web/src/components/form/{QuestionField,FileMetadataField}.tsx`
- Create: `plus/apps/web/src/api/registrations.ts`
- Modify: `router.tsx`, `styles/global.css`
- Tests: `QuestionField.test.tsx`, `FileMetadataField.test.tsx`

- [ ] **Step 1: Join entry**

`/join` code form → `/join/:publicCode`; fetch public activity; login guard;
show not-found/closed states.

- [ ] **Step 2: Start/resume**

`GET mine`; if 404 and active, `POST registrations` with a client `crypto.randomUUID()`
idempotency key; then `GET detail`. Show status/review note.

- [ ] **Step 3: Form**

- text → input/textarea;
- notice → read-only;
- file → file input (`accept` from the slot), POST metadata
  `{questionKey, originalName, contentType: file.type || "application/octet-stream", byteLength: file.size}`;
- show the metadata-only warning.
- Save: sequential PATCH changed text answers, update revision after each; Submit:
  POST submit; render server validation errors.
- `need_supplement` editable; `submitted/approved/rejected` read-only.

- [ ] **Step 4: Tests + commit**.

---

### Task 5: Ops pages

**Files:**
- Create: `plus/apps/web/src/routes/{ops,opsActivity,opsRegistration}.tsx`
- Create: `plus/apps/web/src/components/ops/{RegistrationTable,RosterCard,ReviewPanel}.tsx`
- Create: `plus/apps/web/src/api/ops.ts`
- Modify: `router.tsx`, `styles/global.css`
- Tests: `ReviewPanel.test.tsx`, `RosterCard.test.tsx`

- [ ] **Step 1: `/ops`** activity list; link to activity.
- [ ] **Step 2: `/ops/:activityId`** registration list + roster card (finalize with
  expectedRevision); refresh after review/finalize.
- [ ] **Step 3: detail** frozen questionnaire labels + answers + material metadata;
  review buttons + note; use current revision.
- [ ] **Step 4: Tests + commit**.

---

### Task 6: E2E seed and participant→Ops journey

**Files:**
- Create: `plus/apps/api/scripts/seed-registration.ts`
- Modify: `plus/apps/api/package.json` (`seed:e2e` runs both scripts)
- Modify: `plus/apps/web/e2e/public-results.spec.ts` (keep)
- Create: `plus/apps/web/e2e/registration-loop.spec.ts`

- [ ] **Step 1: Seed**

Create admin `e2e-ops` (password `e2e-ops-password`) with
`registration.review/manage/roster.finalize`; active activity `act-e2e-registration`,
public code `E2E-REG`, enabled registration/questionnaire/materials; insert
`definition_release` version 1 with compiled questionnaire/materials artifacts:
questions name/song/intro/notice/audio(file), fileSlots audio (purpose audio,
accepts [".mp3"], maxBytes 1MB); materials `{maxBytes:1048576, allowedPurposes:["audio"]}`.
Idempotent by activity id / username.

- [ ] **Step 2: E2E**

Use two browser contexts so participant and Ops cookies don't mix.

Participant context: register unique username → `/join` → E2E-REG → fill → set input
files `{name:"demo.mp3", mimeType:"audio/mpeg", buffer}` → save → submit → expect
submitted. Ops context: login `e2e-ops` → `/ops` → activity → registration → approve →
finalize roster → expect final + approved count 1.

- [ ] **Step 3: Run E2E and commit** `test(e2e): cover the registration loop`.

---

### Task 7: Docs, full gate, integration

**Files:** `docs/architecture/adr/0017-cookie-session-and-csrf.md`,
`docs/artflow-plus/roadmap.md`, `plus/README.md`,
`docs/artflow-plus/review-checklist.md`.

- [ ] **Step 1: ADR-0017** cookie/CSRF, self-registration, metadata-only materials,
  same-origin requirement.
- [ ] **Step 2: Docs** roadmap M8b; README auth/E2E commands; checklist.
- [ ] **Step 3: Full gate**

```powershell
$env:ARTFLOW_PLUS_DATABASE_URL = "postgresql://artflow:artflow_dev@127.0.0.1:5433/artflow_plus"
$env:REQUIRE_DB = "1"
pnpm -C plus run check
pnpm -C plus run test
$env:PLAYWRIGHT_CHANNEL = "msedge" # only if bundled Chromium absent locally
pnpm -C plus --filter @artflow-plus/web test:e2e
uv run pytest tests/gates -q
uv run python tests/golden/validate_fixtures.py
uv run python manage.py test tests.golden --noinput
uv run ruff check tests/gates tests/golden
pwsh -NoProfile -File scripts/check_docs.ps1
```

- [ ] **Step 4: Merge/push**

```powershell
git checkout artflow-plus
git merge --no-ff feat/plus-m8b-registration -m "merge: M8b registration loop"
git push origin artflow-plus
gh run watch $(gh run list -L 1 --json databaseId -q '.[0].databaseId') --exit-status
```
