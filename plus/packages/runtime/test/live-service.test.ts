import { randomUUID } from "node:crypto";

import { closeDb, createDb, insertRelease, migrate } from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import type { ActorContext } from "@artflow-plus/domain";
import { Client } from "pg";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getLiveState } from "../src/index.js";
import type { RuntimeDeps } from "../src/index.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_live_${Date.now()}_${process.pid}`;
let db: Kysely<Database>;
let admin: Client;

function deps(permissions: readonly string[]): RuntimeDeps {
  const actor: ActorContext = {
    actorId: "live-staff",
    actorType: "user",
    roles: ["staff"],
    permissions: [...permissions],
  };
  return {
    actor,
    now: () => new Date(Date.UTC(2026, 10, 14, 12, 0, 0)).toISOString(),
    newEventId: () => `live-${randomUUID()}`,
  };
}

async function seed(capabilities: readonly string[]): Promise<string> {
  const activityId = `activity-${randomUUID()}`;
  await db.insertInto("activity").values({
    id: activityId,
    public_code: `LIVE-${activityId.slice(-8)}`,
    title: "毕业晚会",
    status: "active",
    revision: 1,
    enabled_capabilities: JSON.stringify(capabilities),
    active_definition_version: 1,
  }).execute();
  await insertRelease(db, {
    activityId,
    version: 1,
    contentHash: "live-release",
    capabilities: {
      schedule: {
        ok: true,
        capabilityKey: "schedule",
        contentHash: "schedule-content",
        artifact: {
          version: 1,
          schemaVersion: 1,
          slots: [{ key: "programs", label: "节目", durationMinutes: 6, kind: "program" }],
        },
      },
    },
    executionPolicy: {
      declaredScopes: ["schedule"],
      conflicts: {},
      runtimeContractVersion: 2,
      commandScopes: { "schedule.current.advance": ["schedule"] },
    },
    capabilityVersions: { schedule: "1" },
    bindings: [],
    releasedAt: "2026-11-14T09:00:00Z",
    sourceDraftRevision: 1,
  });
  return activityId;
}

describe.skipIf(!connectionString)("live state surfaces", () => {
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

  it("serves a stage-show Live state without a competition snapshot", async () => {
    const activityId = await seed(["registration", "schedule", "incident"]);
    const state = await getLiveState(db, deps(["schedule.manage"]), activityId);
    expect(state.rounds).toEqual([]);
    expect(state.config.rounds).toEqual([]);
    expect(state.activity.enabledCapabilities).toContain("schedule");
  });

  it("rejects actors without a Live surface permission", async () => {
    const activityId = await seed(["schedule"]);
    await expect(getLiveState(db, deps([]), activityId)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("does not let a schedule-only actor read a competition Live state", async () => {
    const activityId = await seed(["competition", "schedule"]);
    await expect(getLiveState(db, deps(["schedule.manage"]), activityId)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});
