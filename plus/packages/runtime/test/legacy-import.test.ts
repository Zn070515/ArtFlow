import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  closeDb,
  createDb,
  getRoster,
  listApprovedParticipantIds,
  migrate,
} from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import type { Kysely } from "kysely";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { importLegacyBundle } from "../src/index.js";
import type { RuntimeDeps } from "../src/index.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_legacy_import_${Date.now()}_${process.pid}`;
const bundle = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/legacy-bundle.json", import.meta.url)), "utf8"),
) as Record<string, unknown>;

let db: Kysely<Database>;
let admin: Client;
const deps: RuntimeDeps = {
  now: () => new Date().toISOString(),
  newEventId: () => crypto.randomUUID(),
};

describe.skipIf(!connectionString)("legacy import", () => {
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

  it("imports activity, release, registrations, and reports reconciliation", async () => {
    const result = await importLegacyBundle(db, deps, {
      commandId: "legacy-import-1",
      bundle,
      dryRun: false,
    });
    expect(result.report.imported.registrations).toBe(2);
    expect(result.report.checks.every((check) => check.ok)).toBe(true);
    const activity = await db.selectFrom("activity").selectAll()
      .where("public_code", "=", "LEG-1").executeTakeFirstOrThrow();
    expect(activity.status).toBe("closed");
    expect(await listApprovedParticipantIds(db, activity.id)).toHaveLength(1);
    expect(await getRoster(db, activity.id)).toMatchObject({ status: "final", approvedCount: 1 });
    const rows = await db.selectFrom("registration").selectAll()
      .where("activity_id", "=", activity.id).execute();
    expect(rows.map((row) => row.status).sort()).toEqual(["approved", "rejected"]);

    const round = await db.selectFrom("competition_round").selectAll()
      .where("activity_id", "=", activity.id).executeTakeFirstOrThrow();
    expect(round.state).toBe("locked");
    expect(round.current_panel_id).not.toBeNull();
    const scores = await db.selectFrom("score_fact").selectAll()
      .where("activity_id", "=", activity.id).execute();
    expect(scores).toHaveLength(1);
    expect(scores[0]).toMatchObject({
      mode: "formal",
      total: "91.50",
      contestant_id: "legacy-user:1",
      judge_id: "legacy-judge:1",
    });
    const rankings = await db.selectFrom("ranking_snapshot").selectAll()
      .where("activity_id", "=", activity.id).execute();
    expect(rankings).toHaveLength(1);
    expect(rankings[0]).toMatchObject({ mode: "formal", status: "ready" });

    const voteSession = await db.selectFrom("vote_session").selectAll()
      .where("activity_id", "=", activity.id).executeTakeFirstOrThrow();
    expect(voteSession).toMatchObject({ mode: "formal", status: "closed" });
    const ballots = await db.selectFrom("ballot").selectAll()
      .where("activity_id", "=", activity.id).execute();
    expect(ballots).toHaveLength(2);
    expect(ballots.every((row) => row.identity_type === "anonymous")).toBe(true);
    const release = await db.selectFrom("result_release").selectAll()
      .where("activity_id", "=", activity.id).executeTakeFirstOrThrow();
    expect(release.status).toBe("active");
    expect(release.snapshot).toMatchObject({
      publicTitle: "2025 院十佳 · 正式赛果",
    });
  });

  it("replays the same bundle without duplicating rows", async () => {
    const imported = await importLegacyBundle(db, deps, {
      commandId: "legacy-import-1",
      bundle,
      dryRun: false,
    });
    const replay = await importLegacyBundle(db, deps, {
      commandId: "legacy-import-1",
      bundle,
      dryRun: false,
    });
    expect(replay.report.bundleHash).toBe(imported.report.bundleHash);
    const count = await db.selectFrom("registration")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .where("activity_id", "=", imported.report.activityId)
      .executeTakeFirstOrThrow();
    expect(Number(count.count)).toBe(2);
  });

  it("rolls back when the declared counts do not match", async () => {
    const tampered = {
      ...bundle,
      activity: { ...(bundle.activity as Record<string, unknown>), publicCode: "LEG-2" },
      source: { ...(bundle.source as Record<string, unknown>), publicCode: "LEG-2" },
      counts: { ...(bundle.counts as Record<string, unknown>), registrations: 99 },
    };
    await expect(importLegacyBundle(db, deps, {
      commandId: "legacy-import-bad",
      bundle: tampered,
      dryRun: false,
    })).rejects.toMatchObject({ code: "LEGACY_RECONCILIATION_FAILED" });
    const found = await db.selectFrom("activity").select("id")
      .where("public_code", "=", "LEG-2").executeTakeFirst();
    expect(found).toBeUndefined();
  });
});
