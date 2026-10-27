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
    const groupingStage = await db.selectFrom("grouping_stage").selectAll()
      .where("activity_id", "=", activity.id).executeTakeFirstOrThrow();
    expect(groupingStage).toMatchObject({
      stage_key: "chorus",
      status: "frozen",
      roster_source: "all_approved",
      material_window: "open",
    });
    const groupingMembers = await db.selectFrom("grouping_membership").selectAll()
      .where("stage_id", "=", groupingStage.id).where("is_current", "=", true).execute();
    expect(groupingMembers.map((row) => row.participant_id)).toEqual(["legacy-user:1"]);
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

  it("derives a ranking when the bundle has no frozen ranking", async () => {
    const noRanking = {
      ...bundle,
      activity: { ...(bundle.activity as Record<string, unknown>), publicCode: "LEG-3" },
      source: { ...(bundle.source as Record<string, unknown>), publicCode: "LEG-3" },
      competition: { ...(bundle.competition as Record<string, unknown>), rankings: [] },
      voting: { sessions: [], ballots: [] },
      results: { stageResults: [], releases: [] },
      counts: {
        ...(bundle.counts as Record<string, unknown>),
        ballots: 0,
        releases: 0,
      },
    };
    const result = await importLegacyBundle(db, deps, {
      commandId: "legacy-import-derived-ranking",
      bundle: noRanking,
      dryRun: false,
    });
    const rankings = await db.selectFrom("ranking_snapshot").selectAll()
      .where("activity_id", "=", result.report.activityId).execute();
    expect(rankings).toHaveLength(1);
    expect(rankings[0]?.mode).toBe("formal");
    expect(rankings[0]?.rows).toMatchObject([
      { contestantId: "legacy-user:1", total: "91.50", judgeCount: 1 },
    ]);
  });

  it("keeps only the latest stage result when v1 has several versions", async () => {
    const results = bundle.results as {
      stageResults: Record<string, unknown>[];
      releases: unknown[];
    };
    const latest = {
      ...results.stageResults[0],
      decisions: [{ rank: 1, contestantId: "legacy-user:1", score: "93.00" }],
      confirmedAt: "2025-10-08T00:00:00Z",
    };
    const duplicated = {
      ...bundle,
      activity: { ...(bundle.activity as Record<string, unknown>), publicCode: "LEG-5" },
      source: { ...(bundle.source as Record<string, unknown>), publicCode: "LEG-5" },
      results: { ...results, stageResults: [...results.stageResults, latest] },
    };
    const result = await importLegacyBundle(db, deps, {
      commandId: "legacy-import-duplicate-stage",
      bundle: duplicated,
      dryRun: false,
    });
    const stages = await db.selectFrom("stage_result").selectAll()
      .where("activity_id", "=", result.report.activityId).execute();
    expect(stages).toHaveLength(1);
    expect(stages[0]?.decisions).toMatchObject([{ score: "93.00" }]);
  });

  it("keeps a synthesized panel consistent with the round judge minimum", async () => {
    const rounds = bundle.rounds as Record<string, unknown>[];
    const variant = {
      ...bundle,
      activity: { ...(bundle.activity as Record<string, unknown>), publicCode: "LEG-6" },
      source: { ...(bundle.source as Record<string, unknown>), publicCode: "LEG-6" },
      rounds: [{ ...rounds[0], judgeCount: 3, minimumJudges: 3 }],
      competition: { ...(bundle.competition as Record<string, unknown>), panels: [], seats: [] },
    };
    const result = await importLegacyBundle(db, deps, {
      commandId: "legacy-import-panel-minimum",
      bundle: variant,
      dryRun: false,
    });
    const panel = await db.selectFrom("panel_snapshot").selectAll()
      .where("activity_id", "=", result.report.activityId).executeTakeFirstOrThrow();
    expect(panel.expected_judges).toBeGreaterThanOrEqual(panel.minimum_judges);
    expect(panel.minimum_judges).toBe(3);
  });

  it("applies drop_high_low when deriving a ranking", async () => {
    const rounds = bundle.rounds as Record<string, unknown>[];
    const scores = (bundle.competition as { scores: Record<string, unknown>[] }).scores;
    const variant = {
      ...bundle,
      activity: { ...(bundle.activity as Record<string, unknown>), publicCode: "LEG-7" },
      source: { ...(bundle.source as Record<string, unknown>), publicCode: "LEG-7" },
      rounds: [{ ...rounds[0], judgeCount: 3, minimumJudges: 1, scoringMethod: "drop_high_low" }],
      competition: {
        ...(bundle.competition as Record<string, unknown>),
        panels: [],
        seats: [],
        performances: [],
        rankings: [],
        scores: [
          { ...scores[0], legacyId: 91, judgeId: "legacy-judge:1", total: "99.00", criteria: { 总分: 99 } },
          { ...scores[0], legacyId: 92, judgeId: "legacy-judge:2", total: "90.00", criteria: { 总分: 90 } },
          { ...scores[0], legacyId: 93, judgeId: "legacy-judge:3", total: "60.00", criteria: { 总分: 60 } },
        ],
      },
      counts: { ...(bundle.counts as Record<string, unknown>), scores: 3 },
    };
    const result = await importLegacyBundle(db, deps, {
      commandId: "legacy-import-drop-high-low",
      bundle: variant,
      dryRun: false,
    });
    const ranking = await db.selectFrom("ranking_snapshot").selectAll()
      .where("activity_id", "=", result.report.activityId).executeTakeFirstOrThrow();
    expect(ranking.rows).toMatchObject([{ contestantId: "legacy-user:1", total: "90.00" }]);
  });

  it("keeps only the last panel current when a round has several snapshots", async () => {
    const panels = (bundle.competition as { panels: Record<string, unknown>[] }).panels;
    const variant = {
      ...bundle,
      activity: { ...(bundle.activity as Record<string, unknown>), publicCode: "LEG-8" },
      source: { ...(bundle.source as Record<string, unknown>), publicCode: "LEG-8" },
      competition: {
        ...(bundle.competition as Record<string, unknown>),
        panels: [
          panels[0],
          { ...panels[0], legacyId: 22 },
        ],
      },
    };
    const result = await importLegacyBundle(db, deps, {
      commandId: "legacy-import-multiple-panels",
      bundle: variant,
      dryRun: false,
    });
    const current = await db.selectFrom("panel_snapshot").selectAll()
      .where("activity_id", "=", result.report.activityId)
      .where("current", "=", true).execute();
    expect(current).toHaveLength(1);
    const all = await db.selectFrom("panel_snapshot").selectAll()
      .where("activity_id", "=", result.report.activityId).execute();
    expect(all).toHaveLength(2);
    expect(all.filter((panel) => panel.state === "superseded")).toHaveLength(1);
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
