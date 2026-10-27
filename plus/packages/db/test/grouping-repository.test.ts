import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import type { Kysely } from "kysely";

import {
  closeDb,
  createDb,
  getGroupingStageByKey,
  insertGroupingGroup,
  insertGroupingMembership,
  insertGroupingStage,
  listCurrentGroupingMemberships,
  listGroupingGroups,
  listGroupingStages,
  migrate,
  updateGroupingStage,
} from "../src/index.js";
import type { Database } from "../src/index.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_grouping_repo_${Date.now()}_${process.pid}`;

let db: Kysely<Database>;
let admin: Client;

const stage = {
  id: "grouping_stage_test",
  activityId: "activity-test",
  stageKey: "chorus",
  name: "分组合唱",
  status: "draft" as const,
  rosterSource: "all_approved" as const,
  sourceFingerprint: "",
  materialWindow: "closed" as const,
  cancelReason: "",
  revision: 1,
};

describe.skipIf(!connectionString)("grouping repository", () => {
  beforeAll(async () => {
    if (!connectionString) return;
    admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = createDb({ connectionString, schema });
    await migrate(db);
    await db.insertInto("activity").values({
      id: "activity-test",
      public_code: "activity-test",
      title: "Grouping",
      status: "active",
      revision: 1,
      enabled_capabilities: JSON.stringify(["grouping"]),
      active_definition_version: 1,
    }).execute();
  });

  afterAll(async () => {
    if (!connectionString) return;
    await closeDb(db);
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });

  it("stores a stage, groups, and current memberships", async () => {
    await insertGroupingStage(db, stage, "2026-10-27T10:00:00Z");
    await insertGroupingGroup(db, {
      id: "grouping_group_a",
      stageId: stage.id,
      groupOrder: 1,
      name: "A 组",
      isActive: true,
    }, "2026-10-27T10:00:01Z");
    await insertGroupingMembership(db, {
      id: "grouping_member_p1",
      stageId: stage.id,
      groupId: "grouping_group_a",
      participantId: "p1",
      isCurrent: true,
      joinedAt: "2026-10-27T10:00:02Z",
      reason: "",
    });

    const found = await getGroupingStageByKey(db, "activity-test", "chorus");
    expect(found?.status).toBe("draft");
    const groups = await listGroupingGroups(db, [stage.id]);
    expect(groups).toHaveLength(1);
    const members = await listCurrentGroupingMemberships(db, stage.id);
    expect(members.map((item) => item.participantId)).toEqual(["p1"]);
    expect((await listGroupingStages(db, "activity-test"))).toHaveLength(1);
  });

  it("enforces one current membership per participant per stage", async () => {
    await expect(
      insertGroupingMembership(db, {
        id: "grouping_member_duplicate",
        stageId: stage.id,
        groupId: "grouping_group_a",
        participantId: "p1",
        isCurrent: true,
        joinedAt: "2026-10-27T10:00:03Z",
        reason: "",
      }),
    ).rejects.toThrow();
  });

  it("updates a stage only at the expected revision", async () => {
    const current = await getGroupingStageByKey(db, "activity-test", "chorus");
    expect(current).not.toBeNull();
    if (current === null) return;
    const saved = await updateGroupingStage(
      db,
      { ...current, status: "confirmed", confirmedAt: "2026-10-27T10:01:00Z", confirmedBy: "staff", revision: 2 },
      current.revision,
    );
    expect(saved).toBe(true);
    const stale = await updateGroupingStage(
      db,
      { ...current, status: "frozen", revision: 3 },
      current.revision,
    );
    expect(stale).toBe(false);
  });
});
