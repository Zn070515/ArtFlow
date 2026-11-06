import { randomUUID } from "node:crypto";

import { sql, type Kysely } from "kysely";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  closeDb,
  createDb,
  insertResultPublication,
  insertResultRelease,
  insertStageResult,
  listResultReleases,
  migrate,
  selectPublicResults,
  updateResultReleaseStatus,
} from "../src/index.js";
import type { Database } from "../src/index.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_publishing_repository_${Date.now()}_${process.pid}`;

let db: Kysely<Database>;
let admin: Client;

const decisions = [
  { rank: 1, contestantId: "singer-a", score: "98.30" },
  { rank: 2, contestantId: "singer-b", score: "97.80" },
];
const awards = [{ award: "冠军", contestantId: "singer-a" }];
const snapshot = {
  activityTitle: "2026 院十佳",
  publicTitle: "2026 院十佳 · 正式赛果",
  stageKey: "final_podium",
  decisions,
  awards,
};

async function seed(activityId: string, publicCode: string): Promise<void> {
  await db
    .insertInto("activity")
    .values({
      id: activityId,
      public_code: publicCode,
      title: "2026 院十佳",
      status: "active",
      revision: 1,
      enabled_capabilities: JSON.stringify([]),
      active_definition_version: 1,
    })
    .execute();
  await insertStageResult(db, {
    id: `stage-${activityId}`,
    activityId,
    stageKey: "final_podium",
    status: "confirmed",
    candidateRevision: 3,
    sourceCandidateRevision: 3,
    inputFingerprint: "fp-1",
    source: {
      kind: "legacy_import",
      aggregateId: `stage-${activityId}`,
      definitionVersion: 1,
      releaseHash: "repo-release",
      mode: "formal",
      sourceRevision: 3,
      inputFingerprint: "fp-1",
      dependencyIds: [],
    },
    decisions,
    awards,
    note: "核定",
    revision: 1,
    confirmedAt: "2026-10-19T17:00:00.000Z",
    staleReason: "",
  });
  await insertResultPublication(db, {
    id: `publication-${activityId}`,
    activityId,
    stageKey: "final_podium",
    title: "正式赛果",
    content: "编辑正文",
    version: 1,
    revision: 0,
  });
}

async function release(activityId: string, releaseId: string): Promise<void> {
  await insertResultRelease(db, {
    id: releaseId,
    activityId,
    publicationId: `publication-${activityId}`,
    stageResultId: `stage-${activityId}`,
    stageKey: "final_podium",
    status: "active",
    snapshot,
    snapshotCandidateRevision: 3,
    resultVersion: 3,
    postVersion: 1,
    inputFingerprint: "fp-1",
    note: "正式发布",
    releasedAt: "2026-10-19T18:00:00.000Z",
    revision: 0,
  });
}

describe.skipIf(!connectionString)("publishing repository", () => {
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

  it("allows only one active release per activity and stage", async () => {
    const activityId = `act-${randomUUID()}`;
    await seed(activityId, activityId);
    await release(activityId, `release-a-${activityId}`);
    await expect(release(activityId, `release-b-${activityId}`)).rejects.toThrow(/result_release_active_key/);
  });

  it("keeps release history and returns only active snapshots publicly", async () => {
    const activityId = `act-${randomUUID()}`;
    const publicCode = `CODE${activityId.slice(-6).toUpperCase()}`;
    await seed(activityId, publicCode);
    await release(activityId, `release-1-${activityId}`);
    expect(await selectPublicResults(db, publicCode)).toMatchObject({
      activity: { publicCode },
      activityTitle: "2026 院十佳",
      results: [{ stageKey: "final_podium", publicTitle: "2026 院十佳 · 正式赛果", decisions }],
    });
    expect(JSON.stringify(await selectPublicResults(db, publicCode))).not.toContain("fp-1");
    await updateResultReleaseStatus(db, {
      id: `release-1-${activityId}`,
      activityId,
      status: "revoked",
      revokedAt: "2026-10-19T19:00:00.000Z",
      supersededAt: null,
      revision: 1,
    });
    expect((await selectPublicResults(db, publicCode))?.results).toEqual([]);
    expect(await listResultReleases(db, activityId, "final_podium")).toHaveLength(1);
    expect(await selectPublicResults(db, "UNKNOWN-CODE")).toBeNull();
  });

  it("hides an ACTIVE release whose source is missing or stale", async () => {
    const activityId = `act-${randomUUID()}`;
    const publicCode = `FRESH${activityId.slice(-6).toUpperCase()}`;
    await seed(activityId, publicCode);
    await release(activityId, `release-fresh-${activityId}`);
    expect((await selectPublicResults(db, publicCode))?.results).toHaveLength(1);

    await db.updateTable("stage_result").set({ source: null })
      .where("id", "=", `stage-${activityId}`).execute();
    expect((await selectPublicResults(db, publicCode))?.results).toEqual([]);

    await db.updateTable("stage_result").set({
      source: JSON.stringify({
        kind: "legacy_import",
        aggregateId: `stage-${activityId}`,
        definitionVersion: 1,
        releaseHash: "repo-release",
        mode: "formal",
        sourceRevision: 3,
        inputFingerprint: "fp-1",
        dependencyIds: [],
      }),
      stale_at: "2026-10-19T20:00:00.000Z",
      stale_reason: "source changed",
    }).where("id", "=", `stage-${activityId}`).execute();
    expect((await selectPublicResults(db, publicCode))?.results).toEqual([]);
  });

  it("keeps an ACTIVE legacy release without a snapshot invisible", async () => {
    const activityId = `act-${randomUUID()}`;
    const publicCode = `LEGACY${activityId.slice(-6).toUpperCase()}`;
    await seed(activityId, publicCode);
    await release(activityId, `release-legacy-active-${activityId}`);
    await db.updateTable("result_release")
      .set({ snapshot: JSON.stringify(null) })
      .where("id", "=", `release-legacy-active-${activityId}`)
      .execute();
    const results = await selectPublicResults(db, publicCode);
    expect(results).not.toBeNull();
    expect(results?.results).toEqual([]);
    expect(results?.activityTitle).toBe("");
  });

  it("keeps activities isolated", async () => {
    const first = `act-${randomUUID()}`;
    const second = `act-${randomUUID()}`;
    await seed(first, `A${first.slice(-6).toUpperCase()}`);
    await seed(second, `B${second.slice(-6).toUpperCase()}`);
    await release(first, `release-first-${first}`);
    expect(await selectPublicResults(db, `A${first.slice(-6).toUpperCase()}`)).not.toBeNull();
    const other = await selectPublicResults(db, `B${second.slice(-6).toUpperCase()}`);
    expect(other?.results).toEqual([]);
    const cross = await sql<{ count: string }>`
      select count(*)::text as count from result_release where activity_id = ${second}
    `.execute(db);
    expect(cross.rows[0]?.count).toBe("0");
  });
});
