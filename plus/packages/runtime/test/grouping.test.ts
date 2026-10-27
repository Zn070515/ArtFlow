import { randomUUID } from "node:crypto";

import { Client } from "pg";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  closeDb,
  createDb,
  insertRelease,
  migrate,
} from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import type { ActorContext } from "@artflow-plus/domain";

import {
  cancelGroupingStage,
  confirmGroupingStage,
  correctGroupingStage,
  createGroupingStage,
  freezeGroupingStage,
  getGroupingState,
  recordGroupingGroups,
} from "../src/index.js";
import type { RuntimeDeps } from "../src/index.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_grouping_${Date.now()}_${process.pid}`;

let db: Kysely<Database>;
let dbB: Kysely<Database>;
let admin: Client;

const staff: ActorContext = {
  actorId: "grouping-staff",
  actorType: "user",
  roles: ["staff"],
  permissions: ["grouping.manage"],
};

function deps(): RuntimeDeps {
  return {
    actor: staff,
    now: () => new Date().toISOString(),
    newEventId: () => randomUUID(),
  };
}

async function seedActivity(participants: readonly string[]): Promise<string> {
  const activityId = `grouping-${randomUUID()}`;
  await db.insertInto("activity").values({
    id: activityId,
    public_code: activityId,
    title: "Grouping test",
    status: "active",
    revision: 1,
    enabled_capabilities: JSON.stringify(["registration", "competition", "grouping"]),
    active_definition_version: 1,
  }).execute();
  await insertRelease(db, {
    activityId,
    version: 1,
    contentHash: "grouping-release",
    capabilities: {
      grouping: {
        ok: true,
        capabilityKey: "grouping",
        contentHash: "grouping-artifact",
        artifact: { schemaVersion: 1, groupCount: 2 },
      },
    },
    executionPolicy: { declaredScopes: [], conflicts: {}, runtimeContractVersion: 1 },
    capabilityVersions: { grouping: "1" },
    bindings: [],
    releasedAt: "2026-10-27T09:00:00Z",
    sourceDraftRevision: 1,
  });
  await db.insertInto("roster").values({
    activity_id: activityId,
    status: "final",
    approved_count: participants.length,
    revision: 1,
    finalized_at: "2026-10-27T09:30:00Z",
    updated_at: new Date(),
  }).execute();
  for (const participantId of participants) {
    await db.insertInto("registration").values({
      id: `registration-${activityId}-${participantId}`,
      activity_id: activityId,
      participant_id: participantId,
      questionnaire_version: "v1",
      questionnaire_hash: "hash",
      status: "approved",
      answers: JSON.stringify({ name: participantId.toUpperCase() }),
      revision: 1,
      review_note: "",
      reviewed_by: "staff",
      created_at: new Date(),
      updated_at: new Date(),
    }).execute();
  }
  return activityId;
}

describe.skipIf(!connectionString)("grouping lifecycle", () => {
  beforeAll(async () => {
    if (!connectionString) return;
    admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = createDb({ connectionString, schema });
    dbB = createDb({ connectionString, schema });
    await migrate(db);
  });

  afterAll(async () => {
    if (!connectionString) return;
    await closeDb(db);
    await closeDb(dbB);
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });

  it("runs draft → confirmed → frozen and rejects a changed source", async () => {
    const activityId = await seedActivity(["p1", "p2", "p3"]);
    const created = await createGroupingStage(db, deps(), {
      commandId: "create-1",
      activityId,
      stageKey: "chorus",
      name: "分组合唱",
      rosterSource: "all_approved",
    });
    expect(created.body.status).toBe("draft");

    const recorded = await recordGroupingGroups(db, deps(), {
      commandId: "record-1",
      activityId,
      stageId: created.body.id,
      expectedRevision: created.body.revision,
      groups: [
        { name: "A", participantIds: ["p1", "p2"] },
        { name: "B", participantIds: ["p3"] },
      ],
    });
    expect(recorded.body.revision).toBe(2);

    const partial = await recordGroupingGroups(db, deps(), {
      commandId: "record-partial",
      activityId,
      stageId: created.body.id,
      expectedRevision: recorded.body.revision,
      groups: [{ name: "A", participantIds: ["p1"] }],
    });
    expect(partial.body.revision).toBe(3);

    const recordedAgain = await recordGroupingGroups(db, deps(), {
      commandId: "record-2",
      activityId,
      stageId: created.body.id,
      expectedRevision: partial.body.revision,
      groups: [
        { name: "A", participantIds: ["p1", "p2"] },
        { name: "B", participantIds: ["p3"] },
      ],
    });

    const confirmed = await confirmGroupingStage(db, deps(), {
      commandId: "confirm-1",
      activityId,
      stageId: created.body.id,
      expectedRevision: recordedAgain.body.revision,
    });
    expect(confirmed.body.status).toBe("confirmed");
    expect(confirmed.body.sourceFingerprint).not.toBe("");

    const frozen = await freezeGroupingStage(db, deps(), {
      commandId: "freeze-1",
      activityId,
      stageId: created.body.id,
      expectedRevision: confirmed.body.revision,
    });
    expect(frozen.body.status).toBe("frozen");
  });

  it("rejects a confirmation that does not cover the roster", async () => {
    const activityId = await seedActivity(["p1", "p2"]);
    const created = await createGroupingStage(db, deps(), {
      commandId: "create-2",
      activityId,
      stageKey: "chorus",
      name: "分组合唱",
      rosterSource: "all_approved",
    });
    const recorded = await recordGroupingGroups(db, deps(), {
      commandId: "record-3",
      activityId,
      stageId: created.body.id,
      expectedRevision: created.body.revision,
      groups: [{ name: "A", participantIds: ["p1"] }],
    });
    await expect(
      confirmGroupingStage(db, deps(), {
        commandId: "confirm-2",
        activityId,
        stageId: created.body.id,
        expectedRevision: recorded.body.revision,
      }),
    ).rejects.toMatchObject({ code: "GROUPING_INCOMPLETE" });
  });

  it("rejects a group count that disagrees with the release", async () => {
    const activityId = await seedActivity(["p1", "p2", "p3"]);
    const created = await createGroupingStage(db, deps(), {
      commandId: "create-3",
      activityId,
      stageKey: "chorus",
      name: "分组合唱",
      rosterSource: "all_approved",
    });
    const recorded = await recordGroupingGroups(db, deps(), {
      commandId: "record-4",
      activityId,
      stageId: created.body.id,
      expectedRevision: created.body.revision,
      groups: [{ name: "A", participantIds: ["p1", "p2", "p3"] }],
    });
    await expect(
      confirmGroupingStage(db, deps(), {
        commandId: "confirm-3",
        activityId,
        stageId: created.body.id,
        expectedRevision: recorded.body.revision,
      }),
    ).rejects.toMatchObject({ code: "GROUPING_GROUP_COUNT" });
  });

  it("rejects a frozen stage when the roster changes after confirmation", async () => {
    const activityId = await seedActivity(["p1", "p2"]);
    const created = await createGroupingStage(db, deps(), {
      commandId: "create-4",
      activityId,
      stageKey: "chorus",
      name: "分组合唱",
      rosterSource: "all_approved",
    });
    const recorded = await recordGroupingGroups(db, deps(), {
      commandId: "record-5",
      activityId,
      stageId: created.body.id,
      expectedRevision: created.body.revision,
      groups: [{ name: "A", participantIds: ["p1"] }, { name: "B", participantIds: ["p2"] }],
    });
    const confirmed = await confirmGroupingStage(db, deps(), {
      commandId: "confirm-4",
      activityId,
      stageId: created.body.id,
      expectedRevision: recorded.body.revision,
    });
    await db.updateTable("roster").set({ approved_count: 3, revision: 2 })
      .where("activity_id", "=", activityId).execute();
    await expect(
      freezeGroupingStage(db, deps(), {
        commandId: "freeze-2",
        activityId,
        stageId: created.body.id,
        expectedRevision: confirmed.body.revision,
      }),
    ).rejects.toMatchObject({ code: "GROUPING_SOURCE_CHANGED" });
  });

  it("keeps membership history on correction and refuses without a reason", async () => {
    const activityId = await seedActivity(["p1", "p2"]);
    const created = await createGroupingStage(db, deps(), {
      commandId: "create-correct",
      activityId,
      stageKey: "chorus",
      name: "分组合唱",
      rosterSource: "all_approved",
    });
    const recorded = await recordGroupingGroups(db, deps(), {
      commandId: "record-correct",
      activityId,
      stageId: created.body.id,
      expectedRevision: created.body.revision,
      groups: [{ name: "A", participantIds: ["p1"] }, { name: "B", participantIds: ["p2"] }],
    });
    const confirmed = await confirmGroupingStage(db, deps(), {
      commandId: "confirm-correct",
      activityId,
      stageId: created.body.id,
      expectedRevision: recorded.body.revision,
    });
    await expect(
      correctGroupingStage(db, deps(), {
        commandId: "correct-no-reason",
        activityId,
        stageId: created.body.id,
        expectedRevision: confirmed.body.revision,
        groups: [{ name: "A", participantIds: ["p1"] }, { name: "B", participantIds: ["p2"] }],
        reason: " ",
      }),
    ).rejects.toBeTruthy();
    const corrected = await correctGroupingStage(db, deps(), {
      commandId: "correct-1",
      activityId,
      stageId: created.body.id,
      expectedRevision: confirmed.body.revision,
      groups: [{ name: "A", participantIds: ["p2"] }, { name: "B", participantIds: ["p1"] }],
      reason: "外部分组表更正",
    });
    expect(corrected.body.status).toBe("confirmed");
    const history = await db.selectFrom("grouping_membership").selectAll()
      .where("stage_id", "=", created.body.id).where("is_current", "=", false).execute();
    expect(history).toHaveLength(2);
  });

  it("cancels a draft once and closes the material window", async () => {
    const activityId = await seedActivity(["p1", "p2"]);
    const created = await createGroupingStage(db, deps(), {
      commandId: "create-cancel",
      activityId,
      stageKey: "chorus",
      name: "分组合唱",
      rosterSource: "all_approved",
    });
    const cancelled = await cancelGroupingStage(db, deps(), {
      commandId: "cancel-1",
      activityId,
      stageId: created.body.id,
      expectedRevision: created.body.revision,
      reason: "当届赛制无分组合唱",
    });
    expect(cancelled.body.status).toBe("cancelled");
    expect(cancelled.body.materialWindow).toBe("closed");
    const again = await cancelGroupingStage(db, deps(), {
      commandId: "cancel-2",
      activityId,
      stageId: created.body.id,
      expectedRevision: cancelled.body.revision,
      reason: "再点一次",
    });
    expect(again.body.status).toBe("cancelled");
  });

  it("refuses correction once a stage result is confirmed", async () => {
    const activityId = await seedActivity(["p1", "p2"]);
    const created = await createGroupingStage(db, deps(), {
      commandId: "create-consumed",
      activityId,
      stageKey: "chorus",
      name: "分组合唱",
      rosterSource: "all_approved",
    });
    const recorded = await recordGroupingGroups(db, deps(), {
      commandId: "record-consumed",
      activityId,
      stageId: created.body.id,
      expectedRevision: created.body.revision,
      groups: [{ name: "A", participantIds: ["p1"] }, { name: "B", participantIds: ["p2"] }],
    });
    const confirmed = await confirmGroupingStage(db, deps(), {
      commandId: "confirm-consumed",
      activityId,
      stageId: created.body.id,
      expectedRevision: recorded.body.revision,
    });
    await db.insertInto("stage_result").values({
      id: "stage-result-1",
      activity_id: activityId,
      stage_key: "final",
      status: "confirmed",
      candidate_revision: 1,
      source_candidate_revision: 1,
      input_fingerprint: "fingerprint",
      decisions: JSON.stringify([]),
      awards: JSON.stringify([]),
      note: "",
      revision: 1,
      confirmed_at: new Date(),
      created_at: new Date(),
      updated_at: new Date(),
    }).execute();
    await expect(
      correctGroupingStage(db, deps(), {
        commandId: "correct-consumed",
        activityId,
        stageId: created.body.id,
        expectedRevision: confirmed.body.revision,
        groups: [{ name: "A", participantIds: ["p2"] }, { name: "B", participantIds: ["p1"] }],
        reason: "改",
      }),
    ).rejects.toMatchObject({ code: "GROUPING_CONSUMED" });
  });

  it("lets exactly one of two concurrent creates with the same key win", async () => {
    const activityId = await seedActivity(["p1", "p2"]);
    const input = {
      activityId,
      stageKey: "chorus",
      name: "分组合唱",
      rosterSource: "all_approved" as const,
    };
    const results = await Promise.allSettled([
      createGroupingStage(db, deps(), { ...input, commandId: "concurrent-create-a" }),
      createGroupingStage(dbB, deps(), { ...input, commandId: "concurrent-create-b" }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    const code = rejected?.status === "rejected" ? rejected.reason.code : undefined;
    expect(code).toBe("GROUPING_STAGE_EXISTS");
  });

  it("rejects a second concurrent mutation at the same revision", async () => {
    const activityId = await seedActivity(["p1", "p2"]);
    const created = await createGroupingStage(db, deps(), {
      commandId: "race-create",
      activityId,
      stageKey: "chorus",
      name: "分组合唱",
      rosterSource: "all_approved",
    });
    const recorded = await recordGroupingGroups(db, deps(), {
      commandId: "race-record",
      activityId,
      stageId: created.body.id,
      expectedRevision: created.body.revision,
      groups: [{ name: "A", participantIds: ["p1"] }, { name: "B", participantIds: ["p2"] }],
    });
    const confirmed = await confirmGroupingStage(db, deps(), {
      commandId: "race-confirm",
      activityId,
      stageId: created.body.id,
      expectedRevision: recorded.body.revision,
    });
    const results = await Promise.allSettled([
      freezeGroupingStage(db, deps(), {
        commandId: "race-freeze",
        activityId,
        stageId: created.body.id,
        expectedRevision: confirmed.body.revision,
      }),
      cancelGroupingStage(dbB, deps(), {
        commandId: "race-cancel",
        activityId,
        stageId: created.body.id,
        expectedRevision: confirmed.body.revision,
        reason: "并发取消",
      }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    const code = rejected?.status === "rejected" ? rejected.reason.code : undefined;
    expect(code).toBe("STALE_REVISION");
  });

  it("describes stages with groups, members, and display names", async () => {
    const activityId = await seedActivity(["p1", "p2"]);
    const created = await createGroupingStage(db, deps(), {
      commandId: "create-read",
      activityId,
      stageKey: "chorus",
      name: "分组合唱",
      rosterSource: "all_approved",
    });
    await recordGroupingGroups(db, deps(), {
      commandId: "record-read",
      activityId,
      stageId: created.body.id,
      expectedRevision: created.body.revision,
      groups: [{ name: "A", participantIds: ["p1"] }, { name: "B", participantIds: ["p2"] }],
    });
    const state = await getGroupingState(db, deps(), { activityId });
    expect(state.stages).toHaveLength(1);
    expect(state.stages[0]?.groupCount).toBe(2);
    expect(state.stages[0]?.matchesGroupCount).toBe(true);
    expect(state.stages[0]?.groups[0]?.members).toEqual([
      { participantId: "p1", displayName: "P1" },
    ]);
  });
});
