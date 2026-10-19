import { randomUUID } from "node:crypto";

import type { Kysely } from "kysely";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  closeDb,
  createDb,
  insertPerformance,
  insertRound,
  insertScoreFact,
  insertScoreRevision,
  migrate,
  updateScoreFact,
} from "../src/index.js";
import type { Database, StoredPerformance, StoredRound, StoredScoreFact } from "../src/index.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_score_repository_${Date.now()}_${process.pid}`;

let db: Kysely<Database>;
let admin: Client;

async function seedScoreFact(): Promise<StoredScoreFact> {
  const activityId = `act-${randomUUID()}`;
  const roundId = `round-${activityId}`;
  const performanceId = `performance-${activityId}`;
  const panelId = `panel-${activityId}`;
  const seatId = `seat-${activityId}`;
  await db.insertInto("activity").values({
    id: activityId,
    title: "Score repository",
    status: "active",
    revision: 1,
    enabled_capabilities: JSON.stringify(["competition"]),
    active_definition_version: 1,
  }).execute();
  const round: StoredRound = {
    id: roundId,
    activityId,
    roundKey: "round-1",
    releaseVersion: 1,
    state: "scoring",
    revision: 1,
    scoreVersion: 0,
    minimumJudges: 3,
    judgeCount: 5,
    completionMode: "minimum_valid",
    advanceCount: 10,
    currentPanelId: panelId,
    lockedAt: null,
  };
  await insertRound(db, round);
  const performance: StoredPerformance = {
    id: performanceId,
    activityId,
    roundId,
    contestantId: "contestant-a",
    sequence: 1,
    state: "open",
    contextVersion: 1,
  };
  await insertPerformance(db, performance);
  return {
    id: `score-${activityId}`,
    activityId,
    roundId,
    performanceId,
    contestantId: "contestant-a",
    judgeId: "judge-1",
    panelSnapshotId: panelId,
    seatId,
    source: "direct_judge",
    total: 91,
    criteria: { technique: 36, stage: 27, emotion: 28 },
    notes: "",
    version: 1,
    contextVersion: 1,
    current: true,
  };
}

describe.skipIf(!connectionString)("score persistence on PostgreSQL", () => {
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

  it("enforces the one current fact per round, contestant, and judge", async () => {
    const fact = await seedScoreFact();
    await db.insertInto("panel_snapshot").values({
      id: fact.panelSnapshotId,
      activity_id: fact.activityId,
      round_id: fact.roundId,
      version: 1,
      state: "active",
      expected_judges: 5,
      minimum_judges: 3,
      roster_digest: "roster",
      context_version: 1,
      current: true,
    }).execute();
    await db.insertInto("judge_seat").values({
      id: fact.seatId,
      panel_id: fact.panelSnapshotId,
      judge_id: "judge-1",
      state: "assigned",
      revision: 0,
    }).execute();
    await insertScoreFact(db, fact);
    await expect(insertScoreFact(db, { ...fact, id: `${fact.id}-duplicate` })).rejects.toThrow();
  });

  it("updates a fact with CAS and keeps an immutable revision row", async () => {
    const fact = await seedScoreFact();
    await db.insertInto("panel_snapshot").values({
      id: fact.panelSnapshotId,
      activity_id: fact.activityId,
      round_id: fact.roundId,
      version: 1,
      state: "active",
      expected_judges: 5,
      minimum_judges: 3,
      roster_digest: "roster",
      context_version: 1,
      current: true,
    }).execute();
    await db.insertInto("judge_seat").values({
      id: fact.seatId,
      panel_id: fact.panelSnapshotId,
      judge_id: "judge-1",
      state: "assigned",
      revision: 0,
    }).execute();
    await insertScoreFact(db, fact);
    const updated = await updateScoreFact(db, { ...fact, total: 93, version: 2 }, 1);
    expect(updated).toMatchObject({ total: 93, version: 2 });
    await insertScoreRevision(db, {
      id: `revision-${fact.id}`,
      scoreFactId: fact.id,
      version: 1,
      source: fact.source,
      total: fact.total,
      criteria: fact.criteria,
      reason: "score correction",
      commandId: "edit-score-1",
      actorId: "staff-1",
      createdAt: "2026-10-19T12:00:00Z",
    });
    await expect(updateScoreFact(db, { ...updated, total: 90, version: 3 }, 1)).rejects.toMatchObject({ code: "STALE_REVISION" });
    await expect(db.selectFrom("score_revision").selectAll().where("score_fact_id", "=", fact.id).execute()).resolves.toHaveLength(1);
  });
});
