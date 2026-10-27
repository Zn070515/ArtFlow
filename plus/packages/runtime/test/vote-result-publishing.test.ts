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

  it("trims padded candidate ids before matching counts", async () => {
    const { activityId, sessionId } = await seed({ counts: [2, 1] });
    await db.updateTable("vote_option")
      .set({ candidate_id: " candidate-0 " })
      .where("id", "=", `${sessionId}-option-0`)
      .execute();
    const preview = await getVoteResultCandidate(db, deps(), { activityId, sessionId });
    expect(preview.decisions[0]).toMatchObject({
      contestantId: "candidate-0",
      count: 2,
    });
  });
});
