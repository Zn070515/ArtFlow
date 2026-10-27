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
  confirmGroupingStage,
  createGroupingStage,
  freezeGroupingStage,
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
});
