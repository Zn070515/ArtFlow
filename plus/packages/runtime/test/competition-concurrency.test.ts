import { COMPETITION_COMMAND_SCOPES } from "@artflow-plus/domain";
import { randomUUID } from "node:crypto";

import {
  closeDb,
  createDb,
  insertRelease,
  insertSession,
  migrate,
  readEventsSince,
} from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import type { ActorContext } from "@artflow-plus/domain";
import type { Kysely } from "kysely";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  activateCompetitionPanel,
  prepareCompetitionRound,
} from "../src/index.js";
import type { RuntimeDeps } from "../src/index.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_competition_concurrency_${Date.now()}_${process.pid}`;

let db1: Kysely<Database>;
let db2: Kysely<Database>;
let admin: Client;
let tick = 0;

const staff: ActorContext = {
  actorId: "competition-concurrency-staff",
  actorType: "user",
  roles: ["staff"],
  permissions: ["competition.manage", "competition.round.prepare"],
};

function deps(): RuntimeDeps {
  return {
    actor: staff,
    now: () => new Date(Date.UTC(2026, 9, 19, 15, 0, tick++)).toISOString(),
    newEventId: () => `competition-concurrency-${randomUUID()}`,
  };
}

async function seed(): Promise<{ activityId: string; roundId: string }> {
  const activityId = `activity-${randomUUID()}`;
  await db1.insertInto("activity").values({
    id: activityId,
    title: "Competition concurrency",
    status: "active",
    revision: 1,
    enabled_capabilities: JSON.stringify(["competition"]),
    active_definition_version: 1,
  }).execute();
  await insertRelease(db1, {
    activityId,
    version: 1,
    contentHash: "competition-concurrency-release",
    capabilities: {
      competition: {
        ok: true,
        capabilityKey: "competition",
        contentHash: "competition-concurrency-content",
        artifact: {
          order: ["roster", "final", "result"],
          nodes: [
            { key: "roster", type: "roster" },
            { key: "final", type: "round" },
            { key: "result", type: "output" },
          ],
          edges: [{ from: "roster", to: "final" }, { from: "final", to: "result" }],
          rounds: [{ key: "final", judgeCount: 2, minimumJudges: 2, completion: "full_matrix", advanceCount: 1, scoringMethod: "average" }],
          rubric: { criteria: [] },
          tiePolicy: "review",
        },
      },
    },
    executionPolicy: { declaredScopes: ["judging"], conflicts: {}, runtimeContractVersion: 1, commandScopes: COMPETITION_COMMAND_SCOPES },
    capabilityVersions: { competition: "1" },
    bindings: [],
    releasedAt: "2026-10-19T14:00:00Z",
    sourceDraftRevision: 1,
  });
  await insertSession(db1, {
    id: `session-${activityId}`,
    activityId,
    definitionVersion: 1,
    contentHash: "competition-concurrency-release",
    scope: "judging",
    mode: "formal",
    status: "running",
    revision: 0,
  }, "2026-10-19T14:30:00Z");
  await db1.insertInto("roster").values({
    activity_id: activityId,
    status: "final",
    approved_count: 2,
    revision: 1,
    finalized_at: "2026-10-19T14:45:00Z",
    updated_at: new Date(),
  }).execute();
  const prepared = await prepareCompetitionRound(db1, deps(), {
    commandId: `prepare-${activityId}`,
    activityId,
    roundKey: "final",
    scope: "judging",
  });
  return { activityId, roundId: prepared.body.id };
}

describe.skipIf(!connectionString)("competition command locking on PostgreSQL", () => {
  beforeAll(async () => {
    if (!connectionString) return;
    admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db1 = createDb({ connectionString, schema });
    db2 = createDb({ connectionString, schema });
    await migrate(db1);
  });

  afterAll(async () => {
    if (!connectionString) return;
    await closeDb(db1);
    await closeDb(db2);
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });

  it("serializes panel activation under the activity lock", async () => {
    const { activityId, roundId } = await seed();
    const results = await Promise.allSettled([
      activateCompetitionPanel(db1, deps(), {
        commandId: "activate-panel-a",
        activityId,
        roundId,
        scope: "judging",
        judges: [{ judgeId: "judge-a", seatKey: "seat-a" }, { judgeId: "judge-b", seatKey: "seat-b" }],
      }),
      activateCompetitionPanel(db2, deps(), {
        commandId: "activate-panel-b",
        activityId,
        roundId,
        scope: "judging",
        judges: [{ judgeId: "judge-a", seatKey: "seat-a" }, { judgeId: "judge-b", seatKey: "seat-b" }],
      }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({ status: "rejected", reason: { code: "PANEL_ALREADY_ACTIVE" } });
    await expect(db1.selectFrom("panel_snapshot").selectAll().where("round_id", "=", roundId).where("current", "=", true).execute()).resolves.toHaveLength(1);
    const events = await readEventsSince(db1, { activityId, after: 0, limit: 100 });
    expect(events.filter((event) => event.type === "PanelSnapshotActivated")).toHaveLength(1);
  });
});
