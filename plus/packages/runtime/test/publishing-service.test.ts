import { randomUUID } from "node:crypto";

import {
  closeDb,
  createDb,
  insertPodiumCandidate,
  insertRelease,
  insertSession,
  migrate,
  readEventsSince,
} from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import type { ActorContext, ExecutionSession } from "@artflow-plus/domain";
import { Client } from "pg";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  confirmStageResult,
  editPublication,
  getPublishingState,
  releaseResult,
  revokeResultRelease,
  unlockStageResult,
} from "../src/index.js";
import type { RuntimeDeps } from "../src/index.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_publishing_service_${Date.now()}_${process.pid}`;
const secret = "m7-test-secret";

let db: Kysely<Database>;
let admin: Client;
let tick = 0;

const staff: ActorContext = {
  actorId: "m7-staff",
  actorType: "user",
  roles: ["staff"],
  permissions: ["result.manage"],
};
const outsider: ActorContext = {
  actorId: "m7-outsider",
  actorType: "user",
  roles: ["participant"],
  permissions: [],
};

function deps(actor: ActorContext): RuntimeDeps {
  return {
    actor,
    credentialSecret: secret,
    now: () => new Date(Date.UTC(2026, 9, 19, 18, 0, tick++)).toISOString(),
    newEventId: () => `m7-${randomUUID()}`,
  };
}

const placements = [
  { place: 1, contestantId: "singer-a", total: "98.30" },
  { place: 2, contestantId: "singer-b", total: "97.80" },
];

async function seedActivity(
  activityId = `act-${randomUUID()}`,
  publicCode = activityId,
  sourceRevision = 3,
  fingerprint = "fp-1",
): Promise<string> {
  await db.insertInto("activity").values({
    id: activityId,
    public_code: publicCode,
    title: "2026 院十佳",
    status: "active",
    revision: 1,
    enabled_capabilities: JSON.stringify(["competition", "publishing"]),
    active_definition_version: 1,
  }).execute();
  await insertRelease(db, {
    activityId,
    version: 1,
    contentHash: "m7-release",
    capabilities: {
      publishing: {
        ok: true,
        capabilityKey: "publishing",
        contentHash: "publishing",
        artifact: {
          version: 1,
          schemaVersion: 1,
          stages: [{ key: "final_podium", label: "正式赛果" }],
        },
      },
    },
    executionPolicy: { declaredScopes: ["publishing"], conflicts: {}, runtimeContractVersion: 1 },
    capabilityVersions: { publishing: "1" },
    bindings: [],
    releasedAt: "2026-10-19T17:00:00Z",
    sourceDraftRevision: 1,
  });
  const session: ExecutionSession = {
    id: `publishing-${activityId}`,
    activityId,
    definitionVersion: 1,
    contentHash: "m7-release",
    scope: "publishing",
    mode: "formal",
    status: "running",
    revision: 0,
  };
  await insertSession(db, session, "2026-10-19T17:00:00Z");
  await insertPodiumCandidate(db, {
    id: `podium-${activityId}`,
    activityId,
    inputFingerprint: fingerprint,
    status: "candidate",
    placements,
    sourceRoundIds: ["round-final"],
    sourceScoreVersions: [{ roundId: "round-final", sourceScoreVersion: 1 }],
    revision: sourceRevision,
  });
  return activityId;
}

describe.skipIf(!connectionString)("publishing service", () => {
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

  it("confirms the latest podium candidate and exposes the staff state", async () => {
    const activityId = await seedActivity();
    const confirmed = await confirmStageResult(db, deps(staff), {
      commandId: "m7-confirm-1",
      activityId,
      stageKey: "final_podium",
      scope: "publishing",
      expectedSourceRevision: 3,
      expectedInputFingerprint: "fp-1",
      awards: [{ award: "冠军", contestantId: "singer-a" }],
      note: "核定",
    });
    expect(confirmed.body).toMatchObject({
      stageKey: "final_podium",
      status: "confirmed",
      candidateRevision: 3,
      sourceCandidateRevision: 3,
      inputFingerprint: "fp-1",
      decisions: [
        { rank: 1, contestantId: "singer-a", score: "98.30" },
        { rank: 2, contestantId: "singer-b", score: "97.80" },
      ],
      awards: [{ award: "冠军", contestantId: "singer-a" }],
      note: "核定",
    });
    const state = await getPublishingState(db, deps(staff), { activityId });
    expect(state.stageResults).toHaveLength(1);
    expect(state.stageResults[0]?.candidateRevision).toBe(3);
    expect(state.stageResults[0]?.note).toBe("核定");
    const confirmedEvent = (await readEventsSince(db, { activityId, after: 0, limit: 100 }))
      .find((event) => event.type === "StageResultConfirmed");
    expect(confirmedEvent?.payload).toMatchObject({ note: "核定" });
  });

  it("rejects stale candidates, bad awards, and missing permission", async () => {
    const activityId = await seedActivity();
    await expect(confirmStageResult(db, deps(staff), {
      commandId: "m7-stale",
      activityId,
      stageKey: "final_podium",
      scope: "publishing",
      expectedSourceRevision: 2,
      expectedInputFingerprint: "fp-1",
      awards: [],
      note: "stale",
    })).rejects.toMatchObject({ code: "STALE_RESOLUTION_INPUT" });
    await expect(confirmStageResult(db, deps(staff), {
      commandId: "m7-bad-award",
      activityId,
      stageKey: "final_podium",
      scope: "publishing",
      expectedSourceRevision: 3,
      expectedInputFingerprint: "fp-1",
      awards: [{ award: "冠军", contestantId: "singer-x" }],
      note: "bad award",
    })).rejects.toMatchObject({ code: "AWARD_INVALID" });
    await expect(confirmStageResult(db, deps(outsider), {
      commandId: "m7-forbidden",
      activityId,
      stageKey: "final_podium",
      scope: "publishing",
      expectedSourceRevision: 3,
      expectedInputFingerprint: "fp-1",
      awards: [],
      note: "forbidden",
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects a held podium candidate", async () => {
    const activityId = await seedActivity("act-hold", "HOLD");
    await db.updateTable("podium_candidate").set({ status: "hold" }).where("activity_id", "=", activityId).execute();
    await expect(confirmStageResult(db, deps(staff), {
      commandId: "m7-hold-confirm",
      activityId,
      stageKey: "final_podium",
      scope: "publishing",
      expectedSourceRevision: 3,
      expectedInputFingerprint: "fp-1",
      awards: [],
      note: "hold",
    })).rejects.toMatchObject({ code: "RESULT_CANDIDATE_HOLD" });
  });

  it("rejects test and rehearsal publishing sessions", async () => {
    const activityId = await seedActivity("act-rehearsal", "REHEARSAL");
    await db.updateTable("execution_session").set({ mode: "rehearsal" }).where("activity_id", "=", activityId).execute();
    await expect(confirmStageResult(db, deps(staff), {
      commandId: "m7-rehearsal-confirm",
      activityId,
      stageKey: "final_podium",
      scope: "publishing",
      expectedSourceRevision: 3,
      expectedInputFingerprint: "fp-1",
      awards: [],
      note: "rehearsal",
    })).rejects.toMatchObject({ code: "FORMAL_MODE_REQUIRED" });
  });

  it("rejects a second confirm without an unlock", async () => {
    const activityId = await seedActivity();
    const input = {
      activityId,
      stageKey: "final_podium",
      scope: "publishing",
      expectedSourceRevision: 3,
      expectedInputFingerprint: "fp-1",
      awards: [],
      note: "confirm",
    };
    await confirmStageResult(db, deps(staff), { ...input, commandId: "m7-twice-1" });
    await expect(
      confirmStageResult(db, deps(staff), { ...input, commandId: "m7-twice-2" }),
    ).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
  });

  it("releases, freezes the publication, revokes, re-releases, and unlocks", async () => {
    const activityId = await seedActivity("act-lifecycle", "LIFECYCLE", 3, "fp-1");
    await confirmStageResult(db, deps(staff), {
      commandId: "m7-life-confirm",
      activityId,
      stageKey: "final_podium",
      scope: "publishing",
      expectedSourceRevision: 3,
      expectedInputFingerprint: "fp-1",
      awards: [{ award: "冠军", contestantId: "singer-a" }],
      note: "核定",
    });
    const released = await releaseResult(db, deps(staff), {
      commandId: "m7-life-release-1",
      activityId,
      stageKey: "final_podium",
      scope: "publishing",
      expectedCandidateRevision: 3,
      note: "正式发布",
    });
    expect(released.body).toMatchObject({
      status: "active",
      stageKey: "final_podium",
      snapshotCandidateRevision: 3,
      resultVersion: 3,
    });
    await expect(editPublication(db, deps(staff), {
      commandId: "m7-life-edit-frozen",
      activityId,
      stageKey: "final_podium",
      scope: "publishing",
      expectedVersion: 1,
      title: "改后的标题",
      content: "正文",
    })).rejects.toMatchObject({ code: "RESULT_POST_FROZEN" });
    const revoked = await revokeResultRelease(db, deps(staff), {
      commandId: "m7-life-revoke",
      activityId,
      releaseId: released.body.id,
      scope: "publishing",
      note: "复核",
    });
    expect(revoked.body.status).toBe("revoked");
    await expect(revokeResultRelease(db, deps(staff), {
      commandId: "m7-life-revoke-again",
      activityId,
      releaseId: released.body.id,
      scope: "publishing",
      note: "again",
    })).rejects.toMatchObject({ code: "RESULT_RELEASE_NOT_ACTIVE" });
    expect((await getPublishingState(db, deps(staff), { activityId })).releases).toHaveLength(1);
    const reReleased = await releaseResult(db, deps(staff), {
      commandId: "m7-life-release-2",
      activityId,
      stageKey: "final_podium",
      scope: "publishing",
      expectedCandidateRevision: 3,
      note: "复核后重新发布",
    });
    expect(reReleased.body.status).toBe("active");
    expect((await getPublishingState(db, deps(staff), { activityId })).releases).toHaveLength(2);
    const unlocked = await unlockStageResult(db, deps(staff), {
      commandId: "m7-life-unlock",
      activityId,
      stageKey: "final_podium",
      scope: "publishing",
      expectedCandidateRevision: 3,
      note: "更正名次",
    });
    expect(unlocked.body).toMatchObject({ status: "ready_to_confirm", candidateRevision: 4 });
    const state = await getPublishingState(db, deps(staff), { activityId });
    expect(state.releases.map((release) => release.status)).toEqual(["revoked", "superseded"]);
  });

  it("rejects release before confirm and a second active release", async () => {
    const activityId = await seedActivity("act-release-guards", "GUARDS");
    await expect(releaseResult(db, deps(staff), {
      commandId: "m7-release-unconfirmed",
      activityId,
      stageKey: "final_podium",
      scope: "publishing",
      expectedCandidateRevision: 3,
      note: "not confirmed",
    })).rejects.toMatchObject({ code: "RESULT_NOT_CONFIRMED" });
    await confirmStageResult(db, deps(staff), {
      commandId: "m7-guard-confirm",
      activityId,
      stageKey: "final_podium",
      scope: "publishing",
      expectedSourceRevision: 3,
      expectedInputFingerprint: "fp-1",
      awards: [],
      note: "confirm",
    });
    await releaseResult(db, deps(staff), {
      commandId: "m7-guard-release-1",
      activityId,
      stageKey: "final_podium",
      scope: "publishing",
      expectedCandidateRevision: 3,
      note: "release",
    });
    await expect(releaseResult(db, deps(staff), {
      commandId: "m7-guard-release-2",
      activityId,
      stageKey: "final_podium",
      scope: "publishing",
      expectedCandidateRevision: 3,
      note: "again",
    })).rejects.toMatchObject({ code: "RESULT_ALREADY_RELEASED" });
  });

  it("serializes two concurrent releases on the same stage through the Activity lock", async () => {
    const activityId = await seedActivity("act-release-race", "RACE");
    await confirmStageResult(db, deps(staff), {
      commandId: "m7-race-confirm",
      activityId,
      stageKey: "final_podium",
      scope: "publishing",
      expectedSourceRevision: 3,
      expectedInputFingerprint: "fp-1",
      awards: [],
      note: "confirm",
    });
    const other = createDb({ connectionString: connectionString ?? "", schema });
    try {
      const results = await Promise.allSettled([
        releaseResult(db, deps(staff), {
          commandId: "m7-race-a",
          activityId,
          stageKey: "final_podium",
          scope: "publishing",
          expectedCandidateRevision: 3,
          note: "a",
        }),
        releaseResult(other, deps({ ...staff, actorId: "m7-staff-b" }), {
          commandId: "m7-race-b",
          activityId,
          stageKey: "final_podium",
          scope: "publishing",
          expectedCandidateRevision: 3,
          note: "b",
        }),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(
        results
          .filter((result) => result.status === "rejected")
          .map((result) => (result as PromiseRejectedResult).reason.code),
      ).toContain("RESULT_ALREADY_RELEASED");
    } finally {
      await closeDb(other);
    }
  });

  it("writes audit and outbox facts for every accepted lifecycle command", async () => {
    const activityId = await seedActivity("act-audit", "AUDIT");
    await confirmStageResult(db, deps(staff), {
      commandId: "m7-audit-confirm",
      activityId,
      stageKey: "final_podium",
      scope: "publishing",
      expectedSourceRevision: 3,
      expectedInputFingerprint: "fp-1",
      awards: [],
      note: "confirm",
    });
    const released = await releaseResult(db, deps(staff), {
      commandId: "m7-audit-release",
      activityId,
      stageKey: "final_podium",
      scope: "publishing",
      expectedCandidateRevision: 3,
      note: "release",
    });
    await revokeResultRelease(db, deps(staff), {
      commandId: "m7-audit-revoke",
      activityId,
      releaseId: released.body.id,
      scope: "publishing",
      note: "revoke",
    });
    const audits = await db.selectFrom("audit_entry").select(["command_id"]).where("activity_id", "=", activityId).execute();
    expect(audits.map((row) => row.command_id)).toEqual(
      expect.arrayContaining(["m7-audit-confirm", "m7-audit-release", "m7-audit-revoke"]),
    );
    const events = await readEventsSince(db, { activityId, after: 0, limit: 100 });
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["StageResultConfirmed", "ResultReleased", "ResultReleaseRevoked"]),
    );
  });
});
