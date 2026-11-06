# Vote-Result Publishing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish a closed audience-vote tally as a normal stage result, without making `publishing` depend on `competition`.

**Architecture:** Remove the static publishing→competition dependency and validate the result source at composition time. Add a vote-result preview query and a dedicated confirm command that reads the closed session's authoritative tally inside the command transaction, freezes it into `stage_result`, and reuses the existing release/public-read path. A `vote-poll` pack exercises the pure-vote shape.

**Tech Stack:** TypeScript 7, Kysely/PostgreSQL 18, Fastify 5 + TypeBox, Vitest, React 19.

**Spec:** `docs/artflow-plus/specs/2026-10-27-vote-result-publishing-design.md`

---

## File map

| File | Responsibility |
|---|---|
| `plus/packages/domain/src/capabilities/publishing.ts` | `unit` on decisions, vote ranking helper, dependency removal, composition hook, manifest |
| `plus/packages/domain/src/activity-packs.ts` | New `vote-poll` pack |
| `plus/packages/domain/test/publishing.test.ts` | Ranking + composition tests |
| `plus/packages/domain/test/registry-packs.test.ts` | `vote-poll` instantiation/compile |
| `plus/packages/runtime/src/publishing-service.ts` | Vote preview + confirm command; explicit source guards |
| `plus/packages/runtime/test/vote-result-publishing.test.ts` | End-to-end runtime journey |
| `plus/apps/api/src/app.ts` | Two routes + schemas; pack catalog |
| `plus/apps/api/test/vote-result.test.ts` | API journey + permission |
| `plus/apps/web/src/api/public-results.ts` | `unit` on public decisions |
| `plus/apps/web/src/components/results/ResultsView.tsx` | Percent rendering |
| `plus/apps/web/src/components/results/ResultsView.test.tsx` | Percent rendering test |
| `docs/architecture/adr/0026-vote-result-publishing.md` | ADR |
| `docs/artflow-plus/roadmap.md` | M10 note |
| `docs/artflow-plus/shape-validation.md` | Gap closed |
| `docs/invariants/results.md` | RES invariant for frozen vote results |

---

## Task 1: Domain — decisions, ranking, and the composition hook

**Files:**
- Modify: `plus/packages/domain/src/capabilities/publishing.ts`
- Modify: `plus/packages/domain/test/publishing.test.ts`

- [ ] **Step 1: Write the failing domain tests**

Append to `plus/packages/domain/test/publishing.test.ts`:

```ts
import {
  buildVoteResultDecisions,
  createEmptyVotingDefinition,
  compileActivityDefinitionPackage,
} from "../src/index.js";
```

```ts
describe("vote result decisions", () => {
  it("ranks by count with ties sharing a rank and ordinal stability", () => {
    const decisions = buildVoteResultDecisions([
      { contestantId: "a", count: 5, share: "50.00", ordinal: 0 },
      { contestantId: "b", count: 10, share: "100.00", ordinal: 1 },
      { contestantId: "c", count: 10, share: "100.00", ordinal: 2 },
    ]);
    expect(decisions).toEqual([
      { rank: 1, contestantId: "b", score: "100.00", unit: "percent" },
      { rank: 1, contestantId: "c", score: "100.00", unit: "percent" },
      { rank: 3, contestantId: "a", score: "50.00", unit: "percent" },
    ]);
  });

  it("rejects empty and malformed entries", () => {
    expectCode(() => buildVoteResultDecisions([]), "INVALID_INPUT");
    expectCode(
      () => buildVoteResultDecisions([{ contestantId: "", count: 1, share: "50.00", ordinal: 0 }]),
      "INVALID_INPUT",
    );
    expectCode(
      () => buildVoteResultDecisions([{ contestantId: "a", count: -1, share: "0.00", ordinal: 0 }]),
      "INVALID_INPUT",
    );
    expectCode(
      () => buildVoteResultDecisions([{ contestantId: "a", count: 1, share: "", ordinal: 0 }]),
      "INVALID_INPUT",
    );
  });
});

describe("publishing composition", () => {
  it("requires competition or voting when publishing is enabled", () => {
    const compiled = compileActivityDefinitionPackage(
      {
        schemaVersion: 1,
        manifest: { key: "vote-only", title: "Vote" },
        capabilities: { publishing: createEmptyPublishingDefinition() },
        bindings: [],
      },
      defaultCapabilityRegistry.compilers,
    );
    expect(compiled.ok).toBe(false);
    if (compiled.ok) return;
    expect(compiled.issues.map((item) => item.code)).toContain(
      "CAPABILITY_RESULT_SOURCE_REQUIRED",
    );
  });

  it("compiles with voting as the result source", () => {
    const compiled = compileActivityDefinitionPackage(
      {
        schemaVersion: 1,
        manifest: { key: "vote-only", title: "Vote" },
        capabilities: {
          publishing: createPublishingDefinition([{ key: "vote_result", label: "投票结果" }]),
          voting: createEmptyVotingDefinition(),
        },
        bindings: [],
      },
      defaultCapabilityRegistry.compilers,
    );
    expect(compiled.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

```powershell
Set-Location "C:\Users\16275\Desktop\ArtFlow\plus\packages\domain"
pnpm exec vitest run test/publishing.test.ts
```
Expected: FAIL — `buildVoteResultDecisions` is not exported.

- [ ] **Step 3: Add `unit` and the ranking helper**

In `plus/packages/domain/src/capabilities/publishing.ts`:

```ts
export interface ResultDecision {
  readonly rank: number;
  readonly contestantId: string;
  readonly score: string;
  readonly unit?: "score" | "percent";
}
```

```ts
export interface VoteResultEntry {
  readonly contestantId: string;
  readonly count: number;
  readonly share: string;
  readonly ordinal: number;
}

/**
 * The single authority for turning a closed vote tally into result decisions.
 * Ties share a rank (1, 1, 3); ordinal breaks the display order.
 */
export function buildVoteResultDecisions(
  entries: readonly VoteResultEntry[],
): readonly ResultDecision[] {
  if (!Array.isArray(entries) || entries.length === 0) {
    fail("INVALID_INPUT", "A vote result needs at least one candidate.");
  }
  for (const entry of entries) {
    if (typeof entry.contestantId !== "string" || entry.contestantId.trim() === "") {
      fail("INVALID_INPUT", "A vote result candidate is empty.");
    }
    if (!Number.isInteger(entry.count) || entry.count < 0) {
      fail("INVALID_INPUT", "Vote counts must be non-negative integers.");
    }
    if (!Number.isInteger(entry.ordinal) || entry.ordinal < 0) {
      fail("INVALID_INPUT", "Vote option ordinals must be non-negative integers.");
    }
    if (typeof entry.share !== "string" || entry.share.trim() === "") {
      fail("INVALID_INPUT", "Vote shares must be non-empty strings.");
    }
  }
  const sorted = [...entries].sort(
    (left, right) => right.count - left.count || left.ordinal - right.ordinal,
  );
  let previousCount: number | null = null;
  let rank = 0;
  return deepFreeze(
    sorted.map((entry, index) => {
      if (previousCount === null || previousCount !== entry.count) rank = index + 1;
      previousCount = entry.count;
      return {
        rank,
        contestantId: entry.contestantId.trim(),
        score: entry.share,
        unit: "percent" as const,
      };
    }),
  );
}
```

- [ ] **Step 4: Add the composition hook and manifest changes**

```ts
export const publishingCompiler: CapabilityCompiler = {
  capabilityKey: "publishing",
  compile: compilePublishingDefinition,
  validateComposition: ({ enabledCapabilities }) => {
    if (enabledCapabilities.includes("competition") || enabledCapabilities.includes("voting")) {
      return [];
    }
    return [
      issue(
        "RESULT_SOURCE_REQUIRED",
        "Publishing needs competition or voting to produce a result.",
        "dependencies",
      ),
    ];
  },
};
```

In `publishingCapability.manifest`:

```ts
    dependencies: [],
    commands: [
      "publishing.stage_result.confirm",
      "publishing.stage_result.unlock",
      "publishing.result.release",
      "publishing.result.revoke",
      "publishing.publication.edit",
      "publishing.vote_result.confirm",
    ],
    queries: ["publishing.state.read", "publishing.public_results.read", "publishing.vote_result.preview"],
```

- [ ] **Step 5: Run the domain tests**

```powershell
Set-Location "C:\Users\16275\Desktop\ArtFlow\plus\packages\domain"
pnpm test
```
Expected: PASS (all domain tests, including the two new blocks).

- [ ] **Step 6: Commit**

```powershell
git add plus/packages/domain/src/capabilities/publishing.ts plus/packages/domain/test/publishing.test.ts
git commit -m "feat(domain): rank vote results and decouple publishing"
```

---

## Task 2: `vote-poll` pack

**Files:**
- Modify: `plus/packages/domain/src/activity-packs.ts`
- Modify: `plus/packages/domain/test/registry-packs.test.ts`
- Modify: `plus/apps/api/src/app.ts` (pack catalog)

- [ ] **Step 1: Write the failing pack test**

In `plus/packages/domain/test/registry-packs.test.ts`, import `VOTE_POLL_PACK` and add:

```ts
it("instantiates the vote-poll pack without competition", () => {
  const result = instantiateActivityPack(VOTE_POLL_PACK, defaultCapabilityRegistry);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.instantiation.enabledCapabilities).toEqual([
    "archive",
    "publishing",
    "voting",
  ]);
  expect(result.instantiation.enabledCapabilities).not.toContain("competition");
  const compiled = compileActivityDefinitionPackage(
    result.instantiation.definition,
    defaultCapabilityRegistry.compilers,
  );
  expect(compiled.ok, JSON.stringify(compiled)).toBe(true);
  expect(JSON.stringify(result.instantiation.definition.capabilities.publishing)).toContain(
    "vote_result",
  );
});
```

- [ ] **Step 2: Run it and confirm it fails**

```powershell
Set-Location "C:\Users\16275\Desktop\ArtFlow\plus\packages\domain"
pnpm exec vitest run test/registry-packs.test.ts
```
Expected: FAIL — `VOTE_POLL_PACK` is not exported.

- [ ] **Step 3: Add the pack**

In `plus/packages/domain/src/activity-packs.ts`, import:

```ts
import { createPublishingDefinition } from "./capabilities/publishing.js";
import { createVotingDefinition } from "./capabilities/voting.js";
```

Append:

```ts
export const VOTE_POLL_PACK: ActivityPack = deepFreeze({
  identity: "vote-poll",
  version: "1",
  title: "Vote Poll",
  baselineCapabilities: ["voting", "publishing"],
  questions: [
    {
      id: "archive",
      prompt: "结束后是否归档？",
      capability: "archive",
      default: true,
    },
  ],
  definitions: {
    voting: createVotingDefinition({
      purpose: "popularity",
      selectionType: "single",
      maxSelections: 1,
      identityPolicy: "browser",
      scoringRule: { kind: "ballot_share_percent", scale: 100, decimals: 2 },
    }),
    publishing: createPublishingDefinition([{ key: "vote_result", label: "投票结果" }]),
  },
});
```

- [ ] **Step 4: Add it to the pack catalog**

In `plus/apps/api/src/app.ts`, add `VOTE_POLL_PACK` to the domain import list and:

```ts
  const packs = options.packs ?? [
    SINGER_COMPETITION_PACK,
    STAGE_SHOW_PACK,
    REVIEW_AWARDS_PACK,
    VOTE_POLL_PACK,
  ];
```

- [ ] **Step 5: Run the pack tests**

```powershell
Set-Location "C:\Users\16275\Desktop\ArtFlow\plus\packages\domain"
pnpm test
```
Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add plus/packages/domain/src/activity-packs.ts plus/packages/domain/test/registry-packs.test.ts plus/apps/api/src/app.ts
git commit -m "feat(packs): add the vote-poll pack"
```

---

## Task 3: Runtime — vote-result preview and confirm

**Files:**
- Modify: `plus/packages/runtime/src/publishing-service.ts`
- Create: `plus/packages/runtime/test/vote-result-publishing.test.ts`

- [ ] **Step 1: Write the failing runtime test**

Create `plus/packages/runtime/test/vote-result-publishing.test.ts`:

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
import type { ActorContext } from "@artflow-plus/domain";
import { Client } from "pg";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  confirmVoteStageResult,
  getVoteResultCandidate,
  releaseResult,
} from "../src/index.js";
import type { RuntimeDeps } from "../src/index.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_vote_result_${Date.now()}_${process.pid}`;

let db: Kysely<Database>;
let admin: Client;

const staff: ActorContext = {
  actorId: "vote-result-staff",
  actorType: "user",
  roles: ["staff"],
  permissions: ["result.manage"],
};

function deps(): RuntimeDeps {
  return {
    actor: staff,
    now: () => new Date().toISOString(),
    newEventId: () => randomUUID(),
  };
}

async function seed(
  options: {
    readonly status?: "closed" | "open";
    readonly mode?: "formal" | "rehearsal";
    readonly counts?: readonly number[];
  } = {},
): Promise<{ activityId: string; sessionId: string }> {
  const activityId = `act-${randomUUID()}`;
  const sessionId = `vote-${randomUUID()}`;
  const mode = options.mode ?? "formal";
  await db.insertInto("activity").values({
    id: activityId,
    public_code: activityId,
    title: "人气投票",
    status: "active",
    revision: 1,
    enabled_capabilities: JSON.stringify(["voting", "publishing"]),
    active_definition_version: 1,
  }).execute();
  await insertRelease(db, {
    activityId,
    version: 1,
    contentHash: "vote-release",
    capabilities: {
      publishing: {
        ok: true,
        capabilityKey: "publishing",
        contentHash: "vote-publishing",
        artifact: {
          version: 1,
          schemaVersion: 1,
          stages: [{ key: "vote_result", label: "投票结果" }],
        },
      },
    },
    executionPolicy: { declaredScopes: ["publishing"], conflicts: {}, runtimeContractVersion: 1 },
    capabilityVersions: { publishing: "1" },
    bindings: [],
    releasedAt: "2026-10-27T09:00:00Z",
    sourceDraftRevision: 1,
  });
  await insertSession(db, {
    id: `publishing-${activityId}`,
    activityId,
    definitionVersion: 1,
    contentHash: "vote-release",
    scope: "publishing",
    mode: "formal",
    status: "running",
    revision: 0,
  }, "2026-10-27T09:00:00Z");
  await db.insertInto("vote_session").values({
    id: sessionId,
    activity_id: activityId,
    definition_version: 1,
    mode,
    purpose: "popularity",
    selection_type: "single",
    max_selections: 1,
    identity_policy: "browser",
    scoring_rule: JSON.stringify({ kind: "ballot_share_percent", scale: 100, decimals: 2 }),
    status: options.status ?? "closed",
    revision: 1,
    opened_at: "2026-10-27T09:00:00Z",
    closed_at: options.status === "open" ? null : "2026-10-27T09:30:00Z",
  }).execute();

  const counts = options.counts ?? [2, 1, 0];
  for (const [index, count] of counts.entries()) {
    const optionId = `${sessionId}-option-${index}`;
    await db.insertInto("vote_option").values({
      id: optionId,
      activity_id: activityId,
      session_id: sessionId,
      candidate_id: `candidate-${index}`,
      ordinal: index,
    }).execute();
    for (let ballot = 0; ballot < count; ballot += 1) {
      const ballotId = `${sessionId}-ballot-${index}-${ballot}`;
      await db.insertInto("ballot").values({
        id: ballotId,
        activity_id: activityId,
        session_id: sessionId,
        identity_type: "browser",
        identity_digest: `digest-${index}-${ballot}`,
        ticket_id: null,
        submitted_at: "2026-10-27T09:10:00Z",
      }).execute();
      await db.insertInto("vote_record").values({
        id: `${sessionId}-record-${index}-${ballot}`,
        activity_id: activityId,
        session_id: sessionId,
        ballot_id: ballotId,
        option_id: optionId,
      }).execute();
    }
  }
  return { activityId, sessionId };
}

describe.skipIf(!connectionString)("vote-result publishing", () => {
  beforeAll(async () => {
    if (!connectionString) return;
    admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = createDb({ connectionString, schema });
    await migrate(db);
  });

  afterAll(async () => {
    if (!connectionString) return;
    await closeDb(db);
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });

  it("previews, confirms, releases, and freezes the vote tally", async () => {
    const { activityId, sessionId } = await seed();
    const preview = await getVoteResultCandidate(db, deps(), { activityId, sessionId });
    expect(preview.status).toBe("ready");
    expect(preview.totalBallots).toBe(3);
    expect(preview.decisions.map((decision) => [decision.rank, decision.score, decision.count])).toEqual([
      [1, "66.67", 2],
      [2, "33.33", 1],
      [3, "0.00", 0],
    ]);

    const confirmed = await confirmVoteStageResult(db, deps(), {
      commandId: "vote-confirm-1",
      activityId,
      stageKey: "vote_result",
      scope: "publishing",
      voteSessionId: sessionId,
      expectedSessionRevision: preview.sessionRevision,
      expectedInputFingerprint: preview.inputFingerprint,
      awards: [{ award: "人气之星", contestantId: "candidate-0" }],
      note: "人气投票结果",
    });
    expect(confirmed.body.status).toBe("confirmed");
    expect(confirmed.body.decisions[0]).toMatchObject({
      rank: 1,
      contestantId: "candidate-0",
      unit: "percent",
    });

    const released = await releaseResult(db, deps(), {
      commandId: "vote-release-1",
      activityId,
      stageKey: "vote_result",
      scope: "publishing",
      expectedCandidateRevision: confirmed.body.candidateRevision,
      note: "公示",
    });
    expect(released.body.snapshot?.decisions[0]).toMatchObject({
      rank: 1,
      contestantId: "candidate-0",
      unit: "percent",
    });
  });

  it("holds a session with no valid ballots", async () => {
    const { activityId, sessionId } = await seed({ counts: [0, 0] });
    const preview = await getVoteResultCandidate(db, deps(), { activityId, sessionId });
    expect(preview.status).toBe("hold");
    expect(preview.decisions).toEqual([]);
    await expect(
      confirmVoteStageResult(db, deps(), {
        commandId: "vote-confirm-hold",
        activityId,
        stageKey: "vote_result",
        scope: "publishing",
        voteSessionId: sessionId,
        expectedSessionRevision: preview.sessionRevision,
        expectedInputFingerprint: preview.inputFingerprint,
        awards: [],
      }),
    ).rejects.toMatchObject({ code: "NO_VALID_BALLOTS" });
  });

  it("rejects a stale fingerprint and a rehearsal session", async () => {
    const { activityId, sessionId } = await seed();
    const preview = await getVoteResultCandidate(db, deps(), { activityId, sessionId });
    await expect(
      confirmVoteStageResult(db, deps(), {
        commandId: "vote-confirm-stale",
        activityId,
        stageKey: "vote_result",
        scope: "publishing",
        voteSessionId: sessionId,
        expectedSessionRevision: preview.sessionRevision,
        expectedInputFingerprint: "stale-fingerprint",
        awards: [],
      }),
    ).rejects.toMatchObject({ code: "STALE_RESOLUTION_INPUT" });

    const rehearsal = await seed({ mode: "rehearsal" });
    await expect(
      confirmVoteStageResult(db, deps(), {
        commandId: "vote-confirm-rehearsal",
        activityId: rehearsal.activityId,
        stageKey: "vote_result",
        scope: "publishing",
        voteSessionId: rehearsal.sessionId,
        expectedSessionRevision: 1,
        expectedInputFingerprint: "whatever",
        awards: [],
      }),
    ).rejects.toMatchObject({ code: "FORMAL_MODE_REQUIRED" });
  });

  it("refuses a second confirm until the stage result is unlocked", async () => {
    const { activityId, sessionId } = await seed();
    const preview = await getVoteResultCandidate(db, deps(), { activityId, sessionId });
    const input = {
      activityId,
      stageKey: "vote_result",
      scope: "publishing",
      voteSessionId: sessionId,
      expectedSessionRevision: preview.sessionRevision,
      expectedInputFingerprint: preview.inputFingerprint,
      awards: [],
    };
    await confirmVoteStageResult(db, deps(), { ...input, commandId: "vote-confirm-a" });
    await expect(
      confirmVoteStageResult(db, deps(), { ...input, commandId: "vote-confirm-b" }),
    ).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```powershell
$env:ARTFLOW_PLUS_DATABASE_URL = "postgresql://artflow:artflow_dev@127.0.0.1:5433/artflow_plus"
$env:REQUIRE_DB = "1"
Set-Location "C:\Users\16275\Desktop\ArtFlow\plus\packages\runtime"
pnpm exec vitest run test/vote-result-publishing.test.ts
```
Expected: FAIL — `getVoteResultCandidate` is not exported.

- [ ] **Step 3: Implement preview and confirm**

In `plus/packages/runtime/src/publishing-service.ts`:

Add imports:

```ts
import { getActivity, getVoteSession, listVoteOptions } from "@artflow-plus/db";
import { buildVoteResultDecisions } from "@artflow-plus/domain";
import type { ResultAward } from "@artflow-plus/domain";
import { stableHash } from "./hash.js";
import { getClosedVoteScores } from "./voting-ticket-service.js";
```

(`getActivity` and the vote readers may already be imported through the existing `@artflow-plus/db` block; merge them there instead of adding a second import.)

Add types and helpers:

```ts
export interface VoteResultCandidateDecision {
  readonly rank: number;
  readonly contestantId: string;
  readonly score: string;
  readonly count: number;
  readonly unit: "percent";
}

export interface VoteResultCandidate {
  readonly sessionId: string;
  readonly sessionRevision: number;
  readonly mode: string;
  readonly totalBallots: number;
  readonly status: "ready" | "hold";
  readonly holdReason?: "NO_VALID_BALLOTS";
  readonly inputFingerprint: string;
  readonly decisions: readonly VoteResultCandidateDecision[];
}

async function voteResultData(
  db: Kysely<Database>,
  activityId: string,
  session: { readonly id: string; readonly revision: number },
): Promise<{
  readonly tally: Awaited<ReturnType<typeof getClosedVoteScores>>;
  readonly entries: readonly {
    readonly contestantId: string;
    readonly count: number;
    readonly share: string;
    readonly ordinal: number;
  }[];
  readonly fingerprint: string;
}> {
  const tally = await getClosedVoteScores(db, session.id);
  const options = await listVoteOptions(db, session.id);
  const entries = options.map((option) => ({
    contestantId: option.candidateId,
    count: tally.rawCounts[option.id] ?? 0,
    share: tally.scoreInputs?.[option.id] ?? "0",
    ordinal: option.ordinal,
  }));
  const countsByOption = Object.fromEntries(
    Object.keys(tally.rawCounts)
      .sort()
      .map((optionId) => [optionId, tally.rawCounts[optionId] ?? 0]),
  );
  const fingerprint = stableHash({
    kind: "vote_result",
    activityId,
    sessionId: session.id,
    sessionRevision: session.revision,
    totalBallots: tally.totalBallots,
    countsByOption,
  });
  return { tally, entries, fingerprint };
}

export async function getVoteResultCandidate(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: { readonly activityId: string; readonly sessionId: string },
): Promise<VoteResultCandidate> {
  requirePermission(runtimeActor(deps), "result.manage");
  const activity = await getActivity(db, input.activityId);
  if (activity === null) throw new DomainError("NOT_FOUND", "The activity was not found.");
  requireCapability(activity, "publishing");
  requireCapability(activity, "voting");
  const session = await getVoteSession(db, input.sessionId);
  if (session === null) throw new DomainError("NOT_FOUND", "The voting session was not found.");
  if (session.activityId !== input.activityId) {
    throw new DomainError("CROSS_ACTIVITY", "The voting session belongs to another activity.");
  }
  if (session.status !== "closed") {
    throw new DomainError("VOTE_SESSION_NOT_OPEN", "Only a closed voting session has publishable scores.");
  }
  const { tally, entries, fingerprint } = await voteResultData(db, activity.id, session);
  if (tally.scoreStatus === "hold") {
    return {
      sessionId: session.id,
      sessionRevision: session.revision,
      mode: session.mode,
      totalBallots: tally.totalBallots,
      status: "hold",
      holdReason: "NO_VALID_BALLOTS",
      inputFingerprint: fingerprint,
      decisions: [],
    };
  }
  const decisions = buildVoteResultDecisions(entries);
  // buildVoteResultDecisions sorts, so attach counts by contestant id, not index.
  const counts = new Map(entries.map((entry) => [entry.contestantId, entry.count]));
  return {
    sessionId: session.id,
    sessionRevision: session.revision,
    mode: session.mode,
    totalBallots: tally.totalBallots,
    status: "ready",
    inputFingerprint: fingerprint,
    decisions: decisions.map((decision) => ({
      ...decision,
      count: counts.get(decision.contestantId) ?? 0,
      unit: "percent" as const,
    })),
  };
}
```

Add the confirm input and command:

```ts
export interface ConfirmVoteStageResultInput {
  readonly commandId: string;
  readonly activityId: string;
  readonly stageKey: string;
  readonly scope: string;
  readonly voteSessionId: string;
  readonly expectedSessionRevision: number;
  readonly expectedInputFingerprint: string;
  readonly awards: readonly ResultAward[];
  readonly note?: string;
}

export async function confirmVoteStageResult(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: ConfirmVoteStageResultInput,
): Promise<CommandOutcome<StoredStageResult>> {
  const actor = runtimeActor(deps);
  const note = input.note?.trim() ?? "";
  return executeCommand(db, {
    commandId: input.commandId,
    activityId: input.activityId,
    capability: "publishing",
    commandType: "publishing.vote_result.confirm",
    scope: input.scope,
    actor,
    payload: {
      stageKey: input.stageKey,
      voteSessionId: input.voteSessionId,
      expectedSessionRevision: input.expectedSessionRevision,
      expectedInputFingerprint: input.expectedInputFingerprint,
      awards: input.awards,
      note,
    },
  }, async (trx) => {
    const { activity, session } = await lockPublishingActivity(trx, actor, input.activityId, input.scope);
    requireCapability(activity, "voting");
    const stage = requireStage(
      await publishingArtifact(trx, activity, session.definitionVersion),
      input.stageKey,
    );
    const voteSession = await getVoteSession(trx, input.voteSessionId);
    if (voteSession === null) throw new DomainError("NOT_FOUND", "The voting session was not found.");
    if (voteSession.activityId !== activity.id) {
      throw new DomainError("CROSS_ACTIVITY", "The voting session belongs to another activity.");
    }
    if (voteSession.status !== "closed") {
      throw new DomainError("VOTE_SESSION_NOT_OPEN", "Only a closed voting session has publishable scores.");
    }
    if (voteSession.mode !== session.mode) {
      throw new DomainError("FORMAL_MODE_REQUIRED", "The voting session belongs to another execution mode.");
    }
    const { tally, entries, fingerprint } = await voteResultData(trx, activity.id, voteSession);
    if (tally.scoreStatus === "hold") {
      throw new DomainError("NO_VALID_BALLOTS", "A voting session with no valid ballots cannot be published.");
    }
    if (
      voteSession.revision !== input.expectedSessionRevision ||
      fingerprint !== input.expectedInputFingerprint
    ) {
      throw new DomainError("STALE_RESOLUTION_INPUT", "The vote tally changed since it was read.");
    }
    const decisions = buildVoteResultDecisions(entries);
    validateAwards(decisions, input.awards);
    const existing = await getStageResultForUpdate(trx, activity.id, stage.key);
    if (existing !== null && existing.status === "confirmed") {
      throw new DomainError("INVALID_TRANSITION", "Unlock the confirmed stage result before confirming it again.");
    }
    const candidateRevision = existing === null
      ? voteSession.revision
      : Math.max(existing.candidateRevision + 1, voteSession.revision);
    const stored: StoredStageResult = {
      id: existing?.id ?? idFromCommand("stage-result", `${activity.id}:${stage.key}`),
      activityId: activity.id,
      stageKey: stage.key,
      status: "confirmed",
      candidateRevision,
      sourceCandidateRevision: voteSession.revision,
      inputFingerprint: fingerprint,
      decisions,
      awards: input.awards.map((award) => ({ award: award.award.trim(), contestantId: award.contestantId })),
      note,
      revision: (existing?.revision ?? 0) + 1,
      confirmedAt: deps.now(),
    };
    if (existing === null) await insertStageResult(trx, stored);
    else await updateStageResult(trx, stored);
    await appendEngineEvent(trx, deps, {
      type: "StageResultConfirmed",
      activityId: activity.id,
      aggregateType: "stage_result",
      aggregateId: stored.id,
      revision: stored.revision,
      capability: "publishing",
      mode: session.mode,
      scope: input.scope,
      payload: {
        stageKey: stored.stageKey,
        candidateRevision: stored.candidateRevision,
        sourceCandidateRevision: stored.sourceCandidateRevision,
        decisions: stored.decisions,
        awards: stored.awards,
        note: stored.note,
        source: { kind: "vote_session", sessionId: voteSession.id },
      },
    });
    return { body: stored, status: existing === null ? 201 : 200 };
  });
}
```

Add the podium guard inside `confirmStageResult` right after `lockPublishingActivity`:

```ts
    requireCapability(activity, "competition");
```

- [ ] **Step 4: Run the runtime test**

```powershell
Set-Location "C:\Users\16275\Desktop\ArtFlow\plus\packages\runtime"
pnpm exec vitest run test/vote-result-publishing.test.ts
```
Expected: PASS (4 tests).

- [ ] **Step 5: Run the existing publishing tests**

```powershell
Set-Location "C:\Users\16275\Desktop\ArtFlow\plus\packages\runtime"
pnpm exec vitest run test/publishing-service.test.ts test/golden-result-release-lifecycle.test.ts
```
Expected: PASS (podium path unchanged).

- [ ] **Step 6: Commit**

```powershell
git add plus/packages/runtime/src/publishing-service.ts plus/packages/runtime/test/vote-result-publishing.test.ts
git commit -m "feat(runtime): confirm and publish a closed vote tally"
```

---

## Task 4: API routes

**Files:**
- Modify: `plus/apps/api/src/app.ts`
- Create: `plus/apps/api/test/vote-result.test.ts`

- [ ] **Step 1: Write the failing API test**

Create `plus/apps/api/test/vote-result.test.ts`:

```ts
import { randomUUID } from "node:crypto";

import {
  closeDb,
  createDb,
  insertLocalAccount,
  insertRelease,
  insertSession,
  migrate,
} from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import { hashPassword } from "@artflow-plus/runtime";
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
const schema = `artflow_api_vote_result_${Date.now()}_${process.pid}`;

let app: FastifyInstance;
let db: Kysely<Database>;
let admin: Client;
let resultToken = "";
let participantToken = "";

const deps: RuntimeDeps = {
  now: () => new Date().toISOString(),
  newEventId: () => randomUUID(),
};

async function seed(): Promise<{ activityId: string; sessionId: string; publicCode: string }> {
  const activityId = `act-${randomUUID()}`;
  const publicCode = `VOTE-${randomUUID().slice(0, 8)}`;
  const sessionId = `vote-${randomUUID()}`;
  await db.insertInto("activity").values({
    id: activityId,
    public_code: publicCode,
    title: "人气投票",
    status: "active",
    revision: 1,
    enabled_capabilities: JSON.stringify(["voting", "publishing"]),
    active_definition_version: 1,
  }).execute();
  await insertRelease(db, {
    activityId,
    version: 1,
    contentHash: "api-vote-release",
    capabilities: {
      publishing: {
        ok: true,
        capabilityKey: "publishing",
        contentHash: "api-vote-publishing",
        artifact: {
          version: 1,
          schemaVersion: 1,
          stages: [{ key: "vote_result", label: "投票结果" }],
        },
      },
    },
    executionPolicy: { declaredScopes: ["publishing"], conflicts: {}, runtimeContractVersion: 1 },
    capabilityVersions: { publishing: "1" },
    bindings: [],
    releasedAt: "2026-10-27T09:00:00Z",
    sourceDraftRevision: 1,
  });
  await insertSession(db, {
    id: `publishing-${activityId}`,
    activityId,
    definitionVersion: 1,
    contentHash: "api-vote-release",
    scope: "publishing",
    mode: "formal",
    status: "running",
    revision: 0,
  }, "2026-10-27T09:00:00Z");
  await db.insertInto("vote_session").values({
    id: sessionId,
    activity_id: activityId,
    definition_version: 1,
    mode: "formal",
    purpose: "popularity",
    selection_type: "single",
    max_selections: 1,
    identity_policy: "browser",
    scoring_rule: JSON.stringify({ kind: "ballot_share_percent", scale: 100, decimals: 2 }),
    status: "closed",
    revision: 1,
    opened_at: "2026-10-27T09:00:00Z",
    closed_at: "2026-10-27T09:30:00Z",
  }).execute();
  for (const [index, count] of [2, 1].entries()) {
    const optionId = `${sessionId}-option-${index}`;
    await db.insertInto("vote_option").values({
      id: optionId,
      activity_id: activityId,
      session_id: sessionId,
      candidate_id: `candidate-${index}`,
      ordinal: index,
    }).execute();
    for (let ballot = 0; ballot < count; ballot += 1) {
      const ballotId = `${sessionId}-ballot-${index}-${ballot}`;
      await db.insertInto("ballot").values({
        id: ballotId,
        activity_id: activityId,
        session_id: sessionId,
        identity_type: "browser",
        identity_digest: `digest-${index}-${ballot}`,
        ticket_id: null,
        submitted_at: "2026-10-27T09:10:00Z",
      }).execute();
      await db.insertInto("vote_record").values({
        id: `${sessionId}-record-${index}-${ballot}`,
        activity_id: activityId,
        session_id: sessionId,
        ballot_id: ballotId,
        option_id: optionId,
      }).execute();
    }
  }
  return { activityId, sessionId, publicCode };
}

async function login(username: string, password: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { "content-type": "application/json" },
    payload: { username, password },
  });
  expect(response.statusCode).toBe(200);
  return response.json().token as string;
}

describe.skipIf(!connectionString)("vote-result routes", () => {
  beforeAll(async () => {
    if (!connectionString) return;
    admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = createDb({ connectionString, schema });
    await migrate(db);
    app = await buildApp({ db, deps, enableRuntimeFacts: true });
    await app.ready();
    await insertLocalAccount(db, {
      username: "vote-result-ops",
      passwordDigest: hashPassword("vote-result-password"),
      actor: {
        actorId: "vote-result-ops",
        actorType: "user",
        roles: ["staff"],
        permissions: ["result.manage"],
      },
      active: true,
    });
    await insertLocalAccount(db, {
      username: "vote-result-participant",
      passwordDigest: hashPassword("participant-password"),
      actor: { actorId: "vote-result-participant", actorType: "user", roles: [], permissions: [] },
      active: true,
    });
    resultToken = await login("vote-result-ops", "vote-result-password");
    participantToken = await login("vote-result-participant", "participant-password");
  });

  afterAll(async () => {
    if (!connectionString) return;
    await closeDb(db);
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });

  it("previews, confirms, releases, and serves the vote result", async () => {
    const { activityId, sessionId, publicCode } = await seed();
    const headers = {
      "content-type": "application/json",
      authorization: `Bearer ${resultToken}`,
    };
    const preview = await app.inject({
      method: "GET",
      url: `/api/activities/${activityId}/publishing/vote-results/${sessionId}`,
      headers,
    });
    expect(preview.statusCode).toBe(200);
    const candidate = preview.json() as {
      sessionRevision: number;
      inputFingerprint: string;
      decisions: { rank: number; score: string }[];
    };
    expect(candidate.decisions.map((item) => item.score)).toEqual(["66.67", "33.33"]);

    const confirmed = await app.inject({
      method: "POST",
      url: `/api/activities/${activityId}/publishing/stage-results/vote_result/confirm-vote`,
      headers: { ...headers, "idempotency-key": "vote-confirm-api" },
      payload: {
        scope: "publishing",
        voteSessionId: sessionId,
        expectedSessionRevision: candidate.sessionRevision,
        expectedInputFingerprint: candidate.inputFingerprint,
        awards: [],
      },
    });
    expect(confirmed.statusCode).toBe(201);
    const stage = confirmed.json() as { candidateRevision: number };

    const released = await app.inject({
      method: "POST",
      url: `/api/activities/${activityId}/publishing/releases`,
      headers: { ...headers, "idempotency-key": "vote-release-api" },
      payload: {
        stageKey: "vote_result",
        scope: "publishing",
        expectedCandidateRevision: stage.candidateRevision,
        note: "公示",
      },
    });
    expect(released.statusCode).toBe(201);

    const publicRead = await app.inject({
      method: "GET",
      url: `/api/public/results/${publicCode}`,
    });
    expect(publicRead.statusCode).toBe(200);
    const body = publicRead.json() as {
      results: { decisions: { rank: number; unit?: string }[] }[];
    };
    expect(body.results[0]?.decisions[0]).toMatchObject({ rank: 1, unit: "percent" });
  });

  it("rejects a caller without result.manage", async () => {
    const { activityId, sessionId } = await seed();
    const response = await app.inject({
      method: "GET",
      url: `/api/activities/${activityId}/publishing/vote-results/${sessionId}`,
      headers: { authorization: `Bearer ${participantToken}` },
    });
    expect(response.statusCode).toBe(403);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```powershell
$env:ARTFLOW_PLUS_DATABASE_URL = "postgresql://artflow:artflow_dev@127.0.0.1:5433/artflow_plus"
$env:REQUIRE_DB = "1"
Set-Location "C:\Users\16275\Desktop\ArtFlow\plus\apps\api"
pnpm exec vitest run test/vote-result.test.ts
```
Expected: FAIL — 404 for the preview route.

- [ ] **Step 3: Add schemas and routes**

In `plus/apps/api/src/app.ts`:

```ts
const VoteResultParamsSchema = Type.Object(
  { id: Type.String({ minLength: 1 }), sessionId: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);

const ConfirmVoteResultBodySchema = Type.Object(
  {
    scope: Type.String({ minLength: 1, maxLength: 100 }),
    voteSessionId: Type.String({ minLength: 1, maxLength: 100 }),
    expectedSessionRevision: Type.Integer({ minimum: 1 }),
    expectedInputFingerprint: Type.String({ minLength: 1, maxLength: 128 }),
    awards: Type.Array(
      Type.Object(
        {
          award: Type.String({ minLength: 1, maxLength: 100 }),
          contestantId: Type.String({ minLength: 1, maxLength: 100 }),
        },
        { additionalProperties: false },
      ),
    ),
    note: Type.Optional(Type.String({ maxLength: 2000 })),
  },
  { additionalProperties: false },
);
```

Add the routes next to the existing publishing routes:

```ts
  app.get(
    "/api/activities/:id/publishing/vote-results/:sessionId",
    { schema: { params: VoteResultParamsSchema } },
    async (request) => {
      const { id, sessionId } = request.params as { id: string; sessionId: string };
      return getVoteResultCandidate(db, await requestDeps(request), {
        activityId: id,
        sessionId,
      });
    },
  );

  app.post(
    "/api/activities/:id/publishing/stage-results/:stageKey/confirm-vote",
    { schema: { params: PublishingStageParamsSchema, body: ConfirmVoteResultBodySchema } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id, stageKey } = request.params as { id: string; stageKey: string };
      const body = request.body as {
        scope: string;
        voteSessionId: string;
        expectedSessionRevision: number;
        expectedInputFingerprint: string;
        awards: { award: string; contestantId: string }[];
        note?: string;
      };
      const outcome = await confirmVoteStageResult(db, await requestDeps(request), {
        commandId,
        activityId: id,
        stageKey,
        scope: body.scope,
        voteSessionId: body.voteSessionId,
        expectedSessionRevision: body.expectedSessionRevision,
        expectedInputFingerprint: body.expectedInputFingerprint,
        awards: body.awards,
        ...(body.note === undefined ? {} : { note: body.note }),
      });
      return reply.status(outcome.status).send(outcome.body);
    },
  );
```

Import `confirmVoteStageResult` and `getVoteResultCandidate` from `@artflow-plus/runtime`.

- [ ] **Step 4: Run the API test**

```powershell
Set-Location "C:\Users\16275\Desktop\ArtFlow\plus\apps\api"
pnpm exec vitest run test/vote-result.test.ts
```
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```powershell
git add plus/apps/api/src/app.ts plus/apps/api/test/vote-result.test.ts
git commit -m "feat(api): expose vote-result preview and confirm"
```

---

## Task 5: Public percent rendering

**Files:**
- Modify: `plus/apps/web/src/api/public-results.ts`
- Modify: `plus/apps/web/src/components/results/ResultsView.tsx`
- Modify: `plus/apps/web/src/components/results/ResultsView.test.tsx`

- [ ] **Step 1: Write the failing render test**

In `plus/apps/web/src/components/results/ResultsView.test.tsx`, add:

```tsx
it("renders a percent unit without the score suffix", () => {
  render(
    <ResultsView
      data={{
        activity: { publicCode: "VOTE-1" },
        activityTitle: "人气投票",
        results: [
          {
            releaseId: "release-1",
            stageKey: "vote_result",
            publicTitle: "人气投票 · 投票结果",
            releasedAt: "2026-10-27T10:00:00Z",
            decisions: [
              { rank: 1, contestantId: "candidate-a", score: "66.67", unit: "percent" },
            ],
            awards: [],
          },
        ],
      }}
    />,
  );
  expect(screen.getByText("66.67%")).toBeInTheDocument();
  expect(screen.getByText(/第 1 名.*candidate-a.*66\.67%/)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run it and confirm it fails**

```powershell
Set-Location "C:\Users\16275\Desktop\ArtFlow\plus\apps\web"
pnpm exec vitest run src/components/results/ResultsView.test.tsx
```
Expected: FAIL — `unit` is not in the type and no percent is rendered.

- [ ] **Step 3: Add the type and rendering**

In `plus/apps/web/src/api/public-results.ts`:

```ts
export interface PublicDecision {
  readonly rank: number;
  readonly contestantId: string;
  readonly score: string;
  readonly unit?: "score" | "percent";
}
```

In `ResultsView.tsx`:

```tsx
function scoreText(decision: PublicDecision): string {
  return decision.unit === "percent" ? `${decision.score}%` : decision.score;
}

function RankRow({ decision }: { readonly decision: PublicDecision }) {
  const champion = decision.rank === 1;
  return (
    <li className={champion ? "rank-row is-champion" : "rank-row"}>
      <span className="rank-number" aria-hidden="true">
        {String(decision.rank).padStart(2, "0")}
      </span>
      <span className="rank-contestant">{decision.contestantId}</span>
      <span className="rank-score">{scoreText(decision)}</span>
      <span className="sr-only">
        第 {decision.rank} 名，{decision.contestantId}，
        {decision.unit === "percent" ? scoreText(decision) : `${decision.score} 分`}
      </span>
    </li>
  );
}
```

- [ ] **Step 4: Run the web tests**

```powershell
Set-Location "C:\Users\16275\Desktop\ArtFlow\plus\apps\web"
pnpm test
```
Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add plus/apps/web/src/api/public-results.ts plus/apps/web/src/components/results/ResultsView.tsx plus/apps/web/src/components/results/ResultsView.test.tsx
git commit -m "feat(web): render vote-result percentages"
```

---

## Task 6: Documentation and full gates

**Files:**
- Create: `docs/architecture/adr/0026-vote-result-publishing.md`
- Modify: `docs/invariants/results.md`
- Modify: `docs/artflow-plus/roadmap.md`
- Modify: `docs/artflow-plus/shape-validation.md`

- [ ] **Step 1: Write ADR-0026**

Create `docs/architecture/adr/0026-vote-result-publishing.md`:

```md
# ADR-0026: Vote results are a publishing source

- **Status**: accepted
- **Date**: 2026-10-27

## Context

`publishing` depended statically on `competition` and its confirm command read
only a podium candidate. A pure audience vote had an authoritative closed tally
but no way to become a published result.

## Decision

- `publishing` no longer depends on `competition`. Its compiler requires at
  least one result source (`competition` or `voting`) in the composition.
- A dedicated `publishing.vote_result.confirm` command freezes a closed vote
  session's tally into `stage_result`; the existing release/revoke/unlock/public
  read path is reused unchanged.
- A preview query returns the ranked decisions, raw counts, session revision,
  and a tally fingerprint. Confirm requires the same revision and fingerprint,
  so ticket revocations after the preview fail closed.
- Ranking: count descending, ordinal ascending; equal counts share a rank
  (`1,1,3`). The public score is the vote share percent, carried by
  `ResultDecision.unit = "percent"`.
- The new `vote-poll` pack is the pure-vote shape: voting + publishing (+
  optional archive), no competition or registration.

## Consequences

- The podium path and its tests are unchanged except for an explicit
  `CAPABILITY_NOT_ENABLED` guard.
- v2 still has no voting UI; operators create/close sessions through the API.
- A closed session's tally can change if tickets are revoked afterwards; the
  fingerprint is the only guard and the preview must be the source of truth for
  the confirm input.
```

- [ ] **Step 2: Record the invariant**

Append to `docs/invariants/results.md`:

```md
## RES-09 投票结果在确认时冻结，预览指纹必须一致

**规则**：从已关闭投票场次生成赛果时，确认命令必须在同一事务内重算 tally，
并要求 `expectedSessionRevision` 与 `expectedInputFingerprint` 同时匹配；写入
`stage_result` 后，公开结果只读这份冻结快照，不再回读投票场次。

**为什么**：关闭场次后票据撤销或数据修正会改变 tally；预览与确认之间必须有
一个显式的指纹闸门，否则公示的内容可能与运营看到的不一致。

**必须攻击的形状**：预览后撤销票据、关闭后改票、用旧指纹确认、rehearsal 场次
进入公开结果。
```

- [ ] **Step 3: Update roadmap and shape validation**

Append to `docs/artflow-plus/roadmap.md` before `## Definition of Done`:

```md
## M10 — Vote-Result Publishing（已完成，2026-10-27）

- `publishing` 解耦 competition，改为组合期要求 competition 或 voting。
- 新增投票赛果预览与 `publishing.vote_result.confirm`；tally 在确认时冻结。
- `vote-poll` pack；公开赛果百分比显示（`ResultDecision.unit`）。
- 出口：domain/runtime/api/web 测试与结构门禁全绿。
```

In `docs/artflow-plus/shape-validation.md`, replace the gap row:

```md
| 纯观众投票活动没有发布路径 | publishing 依赖 competition | 已解耦并新增投票赛果确认（M10）；投票 UI 仍待后续 slice |
```

- [ ] **Step 4: Run docs and gates**

```powershell
Set-Location "C:\Users\16275\Desktop\ArtFlow"
pwsh -NoProfile -File scripts/check_docs.ps1
$env:PYTHONIOENCODING="utf-8"
uv run pytest tests/gates -q
```
Expected: PASS.

- [ ] **Step 5: Run the full Plus gates**

```powershell
$env:ARTFLOW_PLUS_DATABASE_URL = "postgresql://artflow:artflow_dev@127.0.0.1:5433/artflow_plus"
$env:REQUIRE_DB = "1"
Set-Location "C:\Users\16275\Desktop\ArtFlow"
pnpm -C plus run check
pnpm -C plus run test
```
Expected: PASS (all packages).

- [ ] **Step 6: Commit and integrate**

```powershell
git add docs/architecture/adr/0026-vote-result-publishing.md docs/invariants/results.md docs/artflow-plus/roadmap.md docs/artflow-plus/shape-validation.md
git commit -m "docs: record vote-result publishing"
git checkout artflow-plus
git merge --no-ff feat/plus-vote-result -m "merge: vote-result publishing"
git push origin artflow-plus
```

---

## Self-review checklist

- Spec coverage: dependency/composition (Task 1), pack (Task 2), preview/confirm
  (Task 3), API (Task 4), public display (Task 5), docs/gates (Task 6).
- No placeholders: every step names a file, command, and expected result.
- Types line up: `VoteResultCandidate` is returned by the preview and consumed by
  the API test; `ConfirmVoteStageResultInput` matches the route body; `unit` is
  optional everywhere so existing decisions keep compiling.
