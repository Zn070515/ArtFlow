# Participant Vote Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give voters a public `/vote/<sessionId>` page that loads candidates, records a browser/ anonymous ballot, shows an already-voted state, and lets Ops share a link + QR.

**Architecture:** A new public read resolves a formal vote session and returns its activity, title, candidates, selection rules, identity policy, and whether the requesting browser already voted. The React page uses that read for its state and posts to the existing ballot command. The Ops card adds a link, copy button, and client-side QR for open formal sessions.

**Tech Stack:** TypeScript 7, Kysely/PostgreSQL 18, Fastify 5, TypeBox, React 19 + TanStack Router/Query, `qrcode`, Playwright.

**Spec:** `docs/artflow-plus/specs/2026-10-27-participant-vote-page-design.md`

---

## File map

| File | Responsibility |
|---|---|
| `plus/packages/db/src/voting-ticket-repository.ts` | `hasBallotForIdentity` |
| `plus/packages/runtime/src/voting-read-service.ts` | `readPublicVoteSession` |
| `plus/packages/contracts/src/voting.ts` | `PublicVoteSessionSchema` + type |
| `plus/apps/api/src/app.ts` | `GET /api/public/vote/:sessionId` |
| `plus/apps/api/test/public-vote.test.ts` | Public read tests |
| `plus/apps/web/src/api/vote.ts` | Public vote client functions |
| `plus/apps/web/src/routes/vote.tsx` | Vote page |
| `plus/apps/web/src/router.tsx` | `/vote/$sessionId` route |
| `plus/apps/web/src/styles/global.css` | Vote page styles |
| `plus/apps/web/src/components/ops/VotingCard.tsx` | Link, copy, QR |
| `plus/apps/web/package.json` | `qrcode` + types |
| `plus/apps/api/scripts/seed-voting.ts` | Second E2E activity |
| `plus/apps/web/e2e/vote-page.spec.ts` | Voter journey |
| `docs/architecture/adr/0028-participant-vote-page.md` | ADR |
| `docs/artflow-plus/roadmap.md` | M12 |
| `docs/artflow-plus/shape-validation.md` | Gap update |

---

## Task 1: Public read model, ballot check, and contract

**Files:**
- Modify: `plus/packages/db/src/voting-ticket-repository.ts`
- Modify: `plus/packages/runtime/src/voting-read-service.ts`
- Modify: `plus/packages/contracts/src/voting.ts`

> The runtime read file currently imports `getActivity`, `getLiveState`,
> `listVoteOptions`, and `listVoteSessionsForActivity`; add `getVoteSession` and
> `hasBallotForIdentity` to that same db import block, and import `stableHash`
> from `./hash.js`.

- [ ] **Step 1: Add the ballot identity check**

In `plus/packages/db/src/voting-ticket-repository.ts`, append:

```ts
export async function hasBallotForIdentity(
  db: Kysely<Database>,
  sessionId: string,
  identityDigest: string,
): Promise<boolean> {
  const row = await db.selectFrom("ballot")
    .select("id")
    .where("session_id", "=", sessionId)
    .where("identity_type", "=", "browser")
    .where("identity_digest", "=", identityDigest)
    .executeTakeFirst();
  return row !== undefined;
}
```

- [ ] **Step 2: Add the public read**

In `plus/packages/runtime/src/voting-read-service.ts`, add imports:

```ts
import { hasBallotForIdentity } from "@artflow-plus/db";
import { stableHash } from "./hash.js";
```

Append:

```ts
export interface PublicVoteSessionState {
  readonly activityId: string;
  readonly activityTitle: string;
  readonly sessionId: string;
  readonly status: "open" | "closed";
  readonly selectionType: "single" | "multi";
  readonly maxSelections: number;
  readonly identityPolicy: "browser" | "ticket" | "anonymous";
  readonly candidates: readonly {
    readonly optionId: string;
    readonly candidateId: string;
  }[];
  readonly voted: boolean;
}

/** A formal session that can be shared publicly; never exposes tallies or identities. */
export async function readPublicVoteSession(
  db: Kysely<Database>,
  sessionId: string,
  browserFingerprint?: string,
): Promise<PublicVoteSessionState | null> {
  const session = await getVoteSession(db, sessionId);
  if (session === null || session.mode !== "formal") return null;
  const activity = await getActivity(db, session.activityId);
  if (activity === null) return null;
  const options = await listVoteOptions(db, sessionId);
  let voted = false;
  if (
    session.identityPolicy === "browser" &&
    browserFingerprint !== undefined &&
    browserFingerprint.length >= 32
  ) {
    voted = await hasBallotForIdentity(db, sessionId, stableHash(browserFingerprint));
  }
  return {
    activityId: activity.id,
    activityTitle: activity.title,
    sessionId: session.id,
    status: session.status === "closed" ? "closed" : "open",
    selectionType: session.selectionType,
    maxSelections: session.maxSelections,
    identityPolicy: session.identityPolicy,
    candidates: options.map((option) => ({
      optionId: option.id,
      candidateId: option.candidateId,
    })),
    voted,
  };
}
```

`getVoteSession` is already imported in this file. Add `getActivity` to the existing db import list if it is missing.

- [ ] **Step 3: Add the shared contract**

In `plus/packages/contracts/src/voting.ts`, append:

```ts
export const PublicVoteSessionSchema = Type.Object(
  {
    activityId: Type.String({ minLength: 1, maxLength: 100 }),
    activityTitle: Type.String({ maxLength: 200 }),
    sessionId: Type.String({ minLength: 1, maxLength: 100 }),
    status: Type.Union([Type.Literal("open"), Type.Literal("closed")]),
    selectionType: Type.Union([Type.Literal("single"), Type.Literal("multi")]),
    maxSelections: Type.Integer({ minimum: 1 }),
    identityPolicy: Type.Union([
      Type.Literal("browser"),
      Type.Literal("ticket"),
      Type.Literal("anonymous"),
    ]),
    candidates: Type.Array(
      Type.Object(
        {
          optionId: Type.String({ minLength: 1, maxLength: 100 }),
          candidateId: Type.String({ minLength: 1, maxLength: 100 }),
        },
        { additionalProperties: false },
      ),
    ),
    voted: Type.Boolean(),
  },
  { additionalProperties: false },
);

export type PublicVoteSession = Static<typeof PublicVoteSessionSchema>;
```

- [ ] **Step 4: Typecheck**

```powershell
Set-Location "C:\Users\16275\Desktop\ArtFlow\plus"
pnpm --filter @artflow-plus/db check
pnpm --filter @artflow-plus/runtime check
pnpm --filter @artflow-plus/contracts check
```
Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add plus/packages/db/src/voting-ticket-repository.ts plus/packages/runtime/src/voting-read-service.ts plus/packages/contracts/src/voting.ts
git commit -m "feat(voting): add the public vote session read"
```

---

## Task 2: Public API route

**Files:**
- Modify: `plus/apps/api/src/app.ts`
- Create: `plus/apps/api/test/public-vote.test.ts`

- [ ] **Step 1: Write the failing API test**

`plus/apps/api/test/public-vote.test.ts`:

```ts
import { randomUUID } from "node:crypto";

import {
  closeDb,
  createDb,
  insertRelease,
  insertSession,
  migrate,
} from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import { stableHash } from "@artflow-plus/runtime";
import type { RuntimeDeps } from "@artflow-plus/runtime";
import type { FastifyInstance } from "fastify";
import { Client } from "pg";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_api_public_vote_${Date.now()}_${process.pid}`;

let app: FastifyInstance;
let db: Kysely<Database>;
let admin: Client;

const deps: RuntimeDeps = {
  now: () => new Date().toISOString(),
  newEventId: () => randomUUID(),
};

async function seed(options: {
  readonly mode?: "formal" | "rehearsal";
  readonly status?: "open" | "closed";
  readonly identityPolicy?: "browser" | "ticket" | "anonymous";
} = {}): Promise<{ activityId: string; sessionId: string }> {
  const activityId = `act-${randomUUID()}`;
  const sessionId = `vote-${randomUUID()}`;
  const mode = options.mode ?? "formal";
  const identityPolicy = options.identityPolicy ?? "browser";
  await db.insertInto("activity").values({
    id: activityId,
    public_code: activityId,
    title: "人气投票",
    status: "active",
    revision: 1,
    enabled_capabilities: JSON.stringify(["voting"]),
    active_definition_version: 1,
  }).execute();
  await insertRelease(db, {
    activityId,
    version: 1,
    contentHash: "public-vote-release",
    capabilities: {
      voting: {
        ok: true,
        capabilityKey: "voting",
        contentHash: "public-vote",
        artifact: {
          version: 2,
          schemaVersion: 2,
          purpose: "popularity",
          selectionType: "single",
          maxSelections: 1,
          identityPolicy,
          scoringRule: { kind: "ballot_share_percent", scale: 100, decimals: 2 },
        },
      },
    },
    executionPolicy: { declaredScopes: ["voting"], conflicts: {}, runtimeContractVersion: 1 },
    capabilityVersions: { voting: "1" },
    bindings: [],
    releasedAt: "2026-10-27T09:00:00Z",
    sourceDraftRevision: 1,
  });
  if (mode === "formal") {
    await insertSession(db, {
      id: `voting-${activityId}`,
      activityId,
      definitionVersion: 1,
      contentHash: "public-vote-release",
      scope: "voting",
      mode: "formal",
      status: "running",
      revision: 0,
    }, "2026-10-27T09:00:00Z");
  }
  await db.insertInto("vote_session").values({
    id: sessionId,
    activity_id: activityId,
    definition_version: 1,
    mode,
    purpose: "popularity",
    selection_type: "single",
    max_selections: 1,
    identity_policy: identityPolicy,
    scoring_rule: JSON.stringify({ kind: "ballot_share_percent", scale: 100, decimals: 2 }),
    status: options.status ?? "open",
    revision: 0,
    opened_at: "2026-10-27T09:00:00Z",
    closed_at: options.status === "closed" ? "2026-10-27T09:30:00Z" : null,
  }).execute();
  for (const [index, candidateId] of ["alice", "bob"].entries()) {
    await db.insertInto("vote_option").values({
      id: `${sessionId}-option-${index}`,
      activity_id: activityId,
      session_id: sessionId,
      candidate_id: candidateId,
      ordinal: index,
    }).execute();
  }
  return { activityId, sessionId };
}

async function insertBrowserBallot(sessionId: string, fingerprint: string): Promise<void> {
  await db.insertInto("ballot").values({
    id: `ballot-${randomUUID()}`,
    activity_id: (await db.selectFrom("vote_session").select("activity_id")
      .where("id", "=", sessionId).executeTakeFirstOrThrow()).activity_id,
    session_id: sessionId,
    identity_type: "browser",
    identity_digest: stableHash(fingerprint),
    ticket_id: null,
    submitted_at: "2026-10-27T09:10:00Z",
  }).execute();
}

describe.skipIf(!connectionString)("public vote session", () => {
  beforeAll(async () => {
    if (!connectionString) return;
    admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = createDb({ connectionString, schema });
    await migrate(db);
    app = await buildApp({ db, deps, enableRuntimeFacts: true });
    await app.ready();
  });

  afterAll(async () => {
    if (!connectionString) return;
    await app.close();
    await closeDb(db);
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });

  it("returns activity, candidates, rules, and no counts", async () => {
    const { activityId, sessionId } = await seed();
    const response = await app.inject({
      method: "GET",
      url: `/api/public/vote/${sessionId}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      activityId,
      activityTitle: "人气投票",
      sessionId,
      status: "open",
      selectionType: "single",
      maxSelections: 1,
      identityPolicy: "browser",
      candidates: [
        { candidateId: "alice" },
        { candidateId: "bob" },
      ],
      voted: false,
    });
    expect(JSON.stringify(response.json())).not.toContain("counts");
  });

  it("reports voted for the same browser identity only", async () => {
    const { sessionId } = await seed();
    const fingerprint = "a".repeat(43);
    await insertBrowserBallot(sessionId, fingerprint);

    const voted = await app.inject({
      method: "GET",
      url: `/api/public/vote/${sessionId}`,
      headers: { cookie: `artflow_browser_id=${fingerprint}` },
    });
    expect(voted.json()).toMatchObject({ voted: true });

    const other = "b".repeat(43);
    const stranger = await app.inject({
      method: "GET",
      url: `/api/public/vote/${sessionId}`,
      headers: { cookie: `artflow_browser_id=${other}` },
    });
    expect(stranger.json()).toMatchObject({ voted: false });
  });

  it("returns closed and ticket sessions without hiding the reason", async () => {
    const closed = await seed({ status: "closed" });
    const closedRead = await app.inject({
      method: "GET",
      url: `/api/public/vote/${closed.sessionId}`,
    });
    expect(closedRead.json()).toMatchObject({ status: "closed" });

    const ticket = await seed({ identityPolicy: "ticket" });
    const ticketRead = await app.inject({
      method: "GET",
      url: `/api/public/vote/${ticket.sessionId}`,
    });
    expect(ticketRead.json()).toMatchObject({ identityPolicy: "ticket" });
  });

  it("hides rehearsal sessions and unknown ids", async () => {
    const rehearsal = await seed({ mode: "rehearsal" });
    const hidden = await app.inject({
      method: "GET",
      url: `/api/public/vote/${rehearsal.sessionId}`,
    });
    expect(hidden.statusCode).toBe(404);

    const unknown = await app.inject({ method: "GET", url: "/api/public/vote/nope" });
    expect(unknown.statusCode).toBe(404);
  });

  it("does not rate-limit ordinary reads", async () => {
    const { sessionId } = await seed();
    for (let index = 0; index < 5; index += 1) {
      const response = await app.inject({
        method: "GET",
        url: `/api/public/vote/${sessionId}`,
      });
      expect(response.statusCode).toBe(200);
    }
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```powershell
$env:ARTFLOW_PLUS_DATABASE_URL = "postgresql://artflow:artflow_dev@127.0.0.1:5433/artflow_plus"
$env:REQUIRE_DB = "1"
Set-Location "C:\Users\16275\Desktop\ArtFlow\plus\apps\api"
pnpm exec vitest run test/public-vote.test.ts
```
Expected: FAIL — 404 for the new route.

- [ ] **Step 3: Add the route**

In `plus/apps/api/src/app.ts`, next to the public activity route:

```ts
const PublicVoteParamsSchema = Type.Object(
  { sessionId: Type.String({ minLength: 1, maxLength: 100 }) },
  { additionalProperties: false },
);
```

```ts
  app.get(
    "/api/public/vote/:sessionId",
    { schema: { params: PublicVoteParamsSchema } },
    async (request, reply) => {
      const { sessionId } = request.params as { sessionId: string };
      await requirePublicRateLimit(request, `public-vote:${sessionId}`, 120);
      const session = await readPublicVoteSession(
        db,
        sessionId,
        cookieValue(request, "artflow_browser_id"),
      );
      if (session === null) throw new DomainError("NOT_FOUND", "Voting session not found.");
      reply.header("cache-control", "no-store");
      return session;
    },
  );
```

Import `readPublicVoteSession` from `@artflow-plus/runtime`.

- [ ] **Step 4: Run the test**

```powershell
Set-Location "C:\Users\16275\Desktop\ArtFlow\plus\apps\api"
pnpm check
pnpm exec vitest run test/public-vote.test.ts
```
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```powershell
git add plus/apps/api/src/app.ts plus/apps/api/test/public-vote.test.ts
git commit -m "feat(api): expose the public vote session"
```

---

## Task 3: Vote page

**Files:**
- Create: `plus/apps/web/src/api/vote.ts`
- Create: `plus/apps/web/src/routes/vote.tsx`
- Modify: `plus/apps/web/src/router.tsx`
- Modify: `plus/apps/web/src/styles/global.css`

- [ ] **Step 1: Add the public client**

`plus/apps/web/src/api/vote.ts`:

```ts
import type { PublicVoteSession } from "@artflow-plus/contracts";

import { apiFetch } from "./client.js";

export async function fetchPublicVote(sessionId: string): Promise<PublicVoteSession> {
  return apiFetch<PublicVoteSession>(`/api/public/vote/${encodeURIComponent(sessionId)}`);
}

export async function ensureBrowserIdentity(activityId: string): Promise<void> {
  await apiFetch(`/api/activities/${activityId}/voting/browser-identity`);
}

export async function submitVote(
  activityId: string,
  sessionId: string,
  optionIds: readonly string[],
  identity: "browser" | "anonymous",
): Promise<unknown> {
  return apiFetch(`/api/activities/${activityId}/voting/sessions/${sessionId}/ballots`, {
    method: "POST",
    headers: { "idempotency-key": `vote-${crypto.randomUUID()}` },
    body: JSON.stringify({ scope: "voting", optionIds, identity: { type: identity } }),
  });
}
```

- [ ] **Step 2: Build the page**

`plus/apps/web/src/routes/vote.tsx`:

```tsx
import type { PublicVoteSession } from "@artflow-plus/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { useState } from "react";

import { ApiError } from "../api/client.js";
import { ensureBrowserIdentity, fetchPublicVote, submitVote } from "../api/vote.js";

async function loadSession(sessionId: string): Promise<PublicVoteSession> {
  const first = await fetchPublicVote(sessionId);
  if (first.identityPolicy !== "browser" || first.voted) return first;
  try {
    await ensureBrowserIdentity(first.activityId);
    return await fetchPublicVote(sessionId);
  } catch {
    return first;
  }
}

function errorMessage(error: unknown): string {
  const code = error instanceof ApiError ? error.code : "";
  if (code === "DUPLICATE_BALLOT") return "这台设备已经投过票了。";
  if (code === "VOTE_SESSION_CLOSED") return "投票已结束。";
  if (code === "SESSION_NOT_RUNNING") return "投票尚未开始，请稍后再试。";
  if (code === "TOO_MANY_SELECTIONS") return "选择的候选超过上限。";
  if (code === "BALLOT_IDENTITY_INVALID") return "当前设备无法投票，请刷新后重试。";
  if (code === "ACTIVITY_NOT_ACTIVE") return "活动已结束。";
  return error instanceof Error ? error.message : String(error);
}

export function VotePage() {
  const { sessionId } = useParams({ from: "/vote/$sessionId" });
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [justVoted, setJustVoted] = useState(false);

  const query = useQuery({
    queryKey: ["public-vote", sessionId],
    queryFn: () => loadSession(sessionId),
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  const submit = useMutation({
    mutationFn: () => {
      const session = query.data;
      if (session === undefined) throw new Error("投票信息尚未加载。");
      return submitVote(
        session.activityId,
        sessionId,
        selected,
        session.identityPolicy === "anonymous" ? "anonymous" : "browser",
      );
    },
    onSuccess: () => setJustVoted(true),
  });

  const session = query.data;
  const voted = justVoted || session?.voted === true;

  function toggle(optionId: string): void {
    if (session === undefined) return;
    if (session.selectionType === "single") {
      setSelected([optionId]);
      return;
    }
    if (selected.includes(optionId)) {
      setSelected(selected.filter((id) => id !== optionId));
      return;
    }
    if (selected.length >= session.maxSelections) return;
    setSelected([...selected, optionId]);
  }

  return (
    <main className="vote-page">
      <header className="vote-header">
        <p className="eyebrow">VOTE · 投票</p>
        <h1 className="display">{session?.activityTitle ?? "投票"}</h1>
      </header>

      {query.isLoading ? <p className="state-copy">加载中…</p> : null}
      {query.error !== null ? (
        <p className="form-error" role="alert">
          {query.error instanceof ApiError && query.error.status === 404
            ? "投票链接无效或已失效。"
            : "投票信息暂时无法加载。"}
        </p>
      ) : null}

      {session !== undefined ? (
        <section className="vote-card">
          {justVoted ? (
            <p className="state-copy">投票成功，谢谢参与。</p>
          ) : session.status === "closed" ? (
            <p className="state-copy">投票已结束。</p>
          ) : session.identityPolicy === "ticket" ? (
            <p className="state-copy">本场需要现场票据，请联系工作人员。</p>
          ) : voted ? (
            <p className="state-copy">你已经投过票了。</p>
          ) : (
            <>
              <ul className="vote-candidates">
                {session.candidates.map((candidate) => (
                  <li key={candidate.optionId}>
                    <label className="vote-candidate">
                      <input
                        type={session.selectionType === "single" ? "radio" : "checkbox"}
                        name="candidate"
                        checked={selected.includes(candidate.optionId)}
                        onChange={() => toggle(candidate.optionId)}
                      />
                      <span>{candidate.candidateId}</span>
                    </label>
                  </li>
                ))}
              </ul>
              {session.selectionType === "multi" ? (
                <p className="state-copy">
                  最多选择 {session.maxSelections} 个，已选 {selected.length} 个。
                </p>
              ) : null}
              <button
                type="button"
                className="button-primary"
                disabled={selected.length === 0 || submit.isPending}
                onClick={() => submit.mutate()}
              >
                投票
              </button>
            </>
          )}
          {submit.error === null || submit.error === undefined ? null : (
            <p className="form-error" role="alert">{errorMessage(submit.error)}</p>
          )}
        </section>
      ) : null}
    </main>
  );
}
```

- [ ] **Step 3: Register the route**

In `plus/apps/web/src/router.tsx`:

```tsx
import { VotePage } from "./routes/vote.js";
```

```tsx
const voteRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/vote/$sessionId",
  component: VotePage,
});
```

Add `voteRoute` to `rootRoute.addChildren([...])`.

- [ ] **Step 4: Add the styles**

Append to `plus/apps/web/src/styles/global.css`:

```css
.vote-page { max-width: 640px; margin: 0 auto; padding: 32px 20px 64px; display: grid; gap: 20px; }
.vote-header { display: grid; gap: 6px; }
.vote-card { display: grid; gap: 16px; border: 1px solid var(--line, #ddd); border-radius: 14px; padding: 20px; }
.vote-candidates { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
.vote-candidate { display: flex; align-items: center; gap: 12px; padding: 14px 16px; border: 1px solid var(--line, #ddd); border-radius: 12px; font-size: 17px; cursor: pointer; }
.vote-candidate input { width: 20px; height: 20px; }
```

- [ ] **Step 5: Typecheck and unit-test**

```powershell
Set-Location "C:\Users\16275\Desktop\ArtFlow\plus\apps\web"
pnpm check
pnpm test
```
Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add plus/apps/web/src/api/vote.ts plus/apps/web/src/routes/vote.tsx plus/apps/web/src/router.tsx plus/apps/web/src/styles/global.css
git commit -m "feat(web): add the participant vote page"
```

---

## Task 4: Ops link, copy, and QR

**Files:**
- Modify: `plus/apps/web/package.json` (deps)
- Modify: `plus/apps/web/src/components/ops/VotingCard.tsx`
- Modify: `plus/apps/web/src/styles/global.css`

- [ ] **Step 1: Install the QR dependency**

```powershell
Set-Location "C:\Users\16275\Desktop\ArtFlow\plus"
pnpm --filter @artflow-plus/web add qrcode@1.5.4
pnpm --filter @artflow-plus/web add -D @types/qrcode@1.5.6
```

- [ ] **Step 2: Add the link component**

In `plus/apps/web/src/components/ops/VotingCard.tsx`, add imports:

```tsx
import * as QRCode from "qrcode";
import { useEffect, useState } from "react";
```

(`@types/qrcode` uses `export =`, and the web tsconfig does not enable
`esModuleInterop`; a namespace import is the compatible form.)

Add a component above `VotingCard`:

```tsx
function VoteLink({ sessionId }: { readonly sessionId: string }) {
  const [qr, setQr] = useState<string | null>(null);
  const url = `${window.location.origin}/vote/${encodeURIComponent(sessionId)}`;

  useEffect(() => {
    let cancelled = false;
    void QRCode.toDataURL(url, { width: 160, margin: 1 })
      .then((data) => {
        if (!cancelled) setQr(data);
      })
      .catch(() => {
        if (!cancelled) setQr(null);
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  return (
    <div className="vote-link">
      <a href={url} target="_blank" rel="noreferrer">{url}</a>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard?.writeText(url);
        }}
      >
        复制链接
      </button>
      {qr === null ? null : <img src={qr} alt="投票二维码" width={160} height={160} />}
    </div>
  );
}
```

Note: `VotingCard` already imports `useState` from React; replace that import with `useEffect, useState` rather than adding a second import.

- [ ] **Step 3: Render the link for open formal sessions**

Inside the session list item, after the status/candidates block:

```tsx
            {session.status === "open" && session.mode === "formal" ? (
              <VoteLink sessionId={session.id} />
            ) : null}
```

- [ ] **Step 4: Add styles**

Append to `plus/apps/web/src/styles/global.css`:

```css
.vote-link { display: grid; gap: 8px; justify-items: start; margin-top: 8px; }
.vote-link a { word-break: break-all; font-size: 13px; }
.vote-link img { border-radius: 8px; background: #fff; }
```

- [ ] **Step 5: Typecheck and unit-test**

```powershell
Set-Location "C:\Users\16275\Desktop\ArtFlow\plus\apps\web"
pnpm check
pnpm test
```
Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add plus/apps/web/package.json plus/apps/web/src/components/ops/VotingCard.tsx plus/apps/web/src/styles/global.css plus/pnpm-lock.yaml
git commit -m "feat(web): share the vote link and QR"
```

---

## Task 5: E2E seed and voter journey

**Files:**
- Modify: `plus/apps/api/scripts/seed-voting.ts`
- Create: `plus/apps/web/e2e/vote-page.spec.ts`

- [ ] **Step 1: Seed a second activity for the voter E2E**

Refactor `plus/apps/api/scripts/seed-voting.ts` into a reusable helper and seed two activities:

```ts
async function seedActivity(
  activityId: string,
  publicCode: string,
  title: string,
): Promise<void> {
  await db.deleteFrom("result_release").where("activity_id", "=", activityId).execute();
  await db.deleteFrom("result_publication").where("activity_id", "=", activityId).execute();
  await db.deleteFrom("stage_result").where("activity_id", "=", activityId).execute();
  await db.deleteFrom("live_state").where("activity_id", "=", activityId).execute();
  await db.deleteFrom("outbox").where("activity_id", "=", activityId).execute();
  await db.deleteFrom("execution_projection").where("activity_id", "=", activityId).execute();
  await db.deleteFrom("vote_record").where("activity_id", "=", activityId).execute();
  await db.deleteFrom("ballot").where("activity_id", "=", activityId).execute();
  await db.deleteFrom("vote_option").where("activity_id", "=", activityId).execute();
  await db.deleteFrom("vote_session").where("activity_id", "=", activityId).execute();
  await db.deleteFrom("execution_session").where("activity_id", "=", activityId).execute();

  if ((await getActivity(db, activityId)) !== null) return;

  await db.insertInto("activity").values({
    id: activityId,
    public_code: publicCode,
    title,
    status: "active",
    revision: 1,
    enabled_capabilities: JSON.stringify(["voting", "publishing"]),
    active_definition_version: 1,
  }).execute();

  await insertRelease(db, {
    activityId,
    version: 1,
    contentHash: `${publicCode}-release`,
    capabilities: {
      voting: {
        ok: true,
        capabilityKey: "voting",
        contentHash: `${publicCode}-voting`,
        artifact: {
          version: 2,
          schemaVersion: 2,
          purpose: "popularity",
          selectionType: "single",
          maxSelections: 1,
          identityPolicy: "browser",
          scoringRule: { kind: "ballot_share_percent", scale: 100, decimals: 2 },
        },
      },
      publishing: {
        ok: true,
        capabilityKey: "publishing",
        contentHash: `${publicCode}-publishing`,
        artifact: {
          version: 1,
          schemaVersion: 1,
          stages: [{ key: "vote_result", label: "投票结果" }],
        },
      },
    },
    executionPolicy: {
      declaredScopes: ["voting", "publishing"],
      conflicts: {},
      runtimeContractVersion: 1,
    },
    capabilityVersions: { voting: "1", publishing: "1" },
    bindings: [],
    releasedAt: "2026-10-27T09:00:00Z",
    sourceDraftRevision: 1,
  });
}

await seedActivity("act_e2e_voting", "E2E-VOTING", "E2E 投票");
await seedActivity("act_e2e_vote_page", "E2E-VOTE-PAGE", "E2E 投票页");
```

Keep the header/imports and the final `closeDb`/log.

- [ ] **Step 2: Write the voter E2E**

`plus/apps/web/e2e/vote-page.spec.ts`:

```ts
import { expect, test } from "@playwright/test";

test("a voter opens the shared link, votes, and sees the already-voted state", async ({
  page,
  browser,
}) => {
  await page.goto("/login");
  await page.getByLabel("用户名").fill("e2e-ops");
  await page.getByLabel("密码").fill("e2e-ops-password");
  await page.getByRole("button", { name: "登录" }).click();
  await page.waitForURL(/\/ops$/);

  await page.goto("/ops/act_e2e_vote_page");
  const sessionRows = page.locator(".voting-session-row");
  await sessionRows.filter({ hasText: "voting 会话" }).getByRole("button", { name: "启动" }).click();
  await expect(sessionRows.filter({ hasText: "voting 会话" }).getByText("运行中")).toBeVisible();

  await page.getByLabel("候选（每行一个）").fill("alice\nbob");
  await page.getByRole("button", { name: "开启投票" }).click();
  await expect(page.getByAltText("投票二维码")).toBeVisible();
  await expect(page.getByRole("link", { name: /\/vote\// })).toBeVisible();

  const sessions = await page.request.get("/api/activities/act_e2e_vote_page/voting/sessions");
  const session = (await sessions.json()).sessions[0] as { id: string };

  const voterContext = await browser.newContext();
  const voter = await voterContext.newPage();
  await voter.goto(`/vote/${session.id}`);
  await expect(voter.getByRole("heading", { name: "E2E 投票页" })).toBeVisible();
  await voter.getByRole("radio", { name: "alice" }).check();
  await voter.getByRole("button", { name: "投票" }).click();
  await expect(voter.getByText("投票成功")).toBeVisible();

  await voter.reload();
  await expect(voter.getByText("你已经投过票了")).toBeVisible();

  await expect(page.getByText(/alice · 1 票/)).toBeVisible({ timeout: 10_000 });
  await voterContext.close();
});
```

- [ ] **Step 3: Run the voter E2E**

```powershell
$env:ARTFLOW_PLUS_DATABASE_URL = "postgresql://artflow:artflow_dev@127.0.0.1:5433/artflow_plus"
Set-Location "C:\Users\16275\Desktop\ArtFlow\plus\apps\web"
pnpm test:e2e -- e2e/vote-page.spec.ts
```
Expected: PASS (1 test).

- [ ] **Step 4: Run both voting E2Es together**

```powershell
pnpm test:e2e -- e2e/voting.spec.ts e2e/vote-page.spec.ts
```
Expected: PASS (2 tests), proving the two seeded activities do not collide.

- [ ] **Step 5: Commit**

```powershell
git add plus/apps/api/scripts/seed-voting.ts plus/apps/web/e2e/vote-page.spec.ts
git commit -m "test(e2e): cover the participant vote page"
```

---

## Task 6: Documentation and full gates

**Files:**
- Create: `docs/architecture/adr/0028-participant-vote-page.md`
- Modify: `docs/artflow-plus/roadmap.md`
- Modify: `docs/artflow-plus/shape-validation.md`

- [ ] **Step 1: Write ADR-0028**

```md
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
```

- [ ] **Step 2: Update roadmap and shape validation**

Append to `docs/artflow-plus/roadmap.md` before `## Definition of Done`:

```md
## M12 — Participant Vote Page（已完成，2026-10-27）

- 公开读 `/api/public/vote/:sessionId`（只 formal，无票数/身份）。
- `/vote/<sessionId>` 页面：browser/anonymous 投票、已投状态、ticket 明确阻断。
- Ops 卡片提供投票链接、复制与二维码。
- 出口：公开读测试、投票页 E2E、全量门禁全绿。
```

In `docs/artflow-plus/shape-validation.md`, add a row:

```md
| 参与者投票页缺失 | v2 只有 ballot 写接口，观众没有投票入口 | 已由 M12 的 `/vote/<sessionId>` 关闭；票据投票仍待后续 slice |
```

- [ ] **Step 3: Run docs and gates**

```powershell
Set-Location "C:\Users\16275\Desktop\ArtFlow"
pwsh -NoProfile -File scripts/check_docs.ps1
$env:PYTHONIOENCODING="utf-8"
uv run pytest tests/gates -q
```
Expected: PASS.

- [ ] **Step 4: Run the full Plus gates**

```powershell
$env:ARTFLOW_PLUS_DATABASE_URL = "postgresql://artflow:artflow_dev@127.0.0.1:5433/artflow_plus"
$env:REQUIRE_DB = "1"
Set-Location "C:\Users\16275\Desktop\ArtFlow"
pnpm -C plus run check
pnpm -C plus run test
```
Expected: PASS (all packages).

- [ ] **Step 5: Commit and integrate**

```powershell
git add docs/architecture/adr/0028-participant-vote-page.md docs/artflow-plus/roadmap.md docs/artflow-plus/shape-validation.md
git commit -m "docs: record the participant vote page"
git checkout artflow-plus
git merge --no-ff feat/plus-vote-page -m "merge: participant vote page"
git push origin artflow-plus
```

---

## Self-review checklist

- Spec coverage: public read (Tasks 1-2), page (Task 3), Ops link/QR (Task 4),
  E2E (Task 5), docs/gates (Task 6).
- No placeholders: every step names files, commands, and expected results.
- Public read has no counts/identities; only formal sessions.
- `voted` uses the same digest as the ballot command.
- E2E uses two separate seeded activities so the existing Ops voting test and the
  voter test cannot collide.
