import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { closeDb, createDb, migrate } from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import { defaultCapabilityRegistry, SINGER_COMPETITION_PACK } from "@artflow-plus/domain";
import type { ActorContext } from "@artflow-plus/domain";
import type { Kysely } from "kysely";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  activateCompetitionPanel,
  adoptLegacyBundle,
  openVoteSession,
  startExecution,
} from "../src/index.js";
import type { RuntimeDeps } from "../src/index.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_legacy_adoption_${Date.now()}_${process.pid}`;
const source = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/legacy-bundle.json", import.meta.url)), "utf8"),
) as Record<string, unknown>;

// A current activity is adopted before its results exist. Historical results,
// scores and ballots stay in v1 and are not part of the adoption bundle.
const bundle: Record<string, unknown> = {
  ...source,
  activity: { ...(source.activity as Record<string, unknown>), publicCode: "ADOPT-1" },
  source: { ...(source.source as Record<string, unknown>), publicCode: "ADOPT-1" },
  competition: {
    ...(source.competition as Record<string, unknown>),
    panels: [],
    seats: [],
    performances: [],
    scores: [],
    rankings: [],
  },
  voting: {
    ...(source.voting as Record<string, unknown>),
    sessions: [],
    ballots: [],
  },
  results: {
    ...(source.results as Record<string, unknown>),
    stageResults: [],
    releases: [],
  },
};

let db: Kysely<Database>;
let admin: Client;
const staff: ActorContext = {
  actorId: "adoption-staff",
  actorType: "user",
  roles: ["admin"],
  permissions: [
    "studio.manage",
    "competition.manage",
    "voting.manage",
    "result.manage",
    "archive.manage",
    "ticket.manage",
    "grouping.manage",
    "registration.manage",
  ],
};
const deps: RuntimeDeps = {
  actor: staff,
  now: () => new Date().toISOString(),
  newEventId: () => crypto.randomUUID(),
};

describe.skipIf(!connectionString)("legacy operational adoption", () => {
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

  it("turns a current v1 activity into a released, runnable Plus activity", async () => {
    const result = await adoptLegacyBundle(db, deps, {
      commandId: "legacy-adopt-1",
      bundle,
      dryRun: false,
      registry: defaultCapabilityRegistry,
      pack: SINGER_COMPETITION_PACK,
      answers: { "audience-voting": true },
      enable: ["ticketing"],
    });
    expect(result.report.mode).toBe("adoption");
    expect(result.report.rehearsalReady).toBe(true);
    expect(result.report.checks.every((check) => check.ok)).toBe(true);
    expect(result.report.capabilities).toEqual(
      expect.arrayContaining(["competition", "registration", "voting", "ticketing", "publishing", "grouping"]),
    );

    const activity = await db.selectFrom("activity").selectAll()
      .where("public_code", "=", "ADOPT-1").executeTakeFirstOrThrow();
    expect(activity).toMatchObject({ status: "active", active_definition_version: 1 });

    const release = await db.selectFrom("definition_release").selectAll()
      .where("activity_id", "=", activity.id).executeTakeFirstOrThrow();
    const policy = typeof release.execution_policy === "string"
      ? JSON.parse(release.execution_policy) as { runtimeContractVersion: number; commandScopes: Record<string, string[]> }
      : release.execution_policy as { runtimeContractVersion: number; commandScopes: Record<string, string[]> };
    expect(policy.runtimeContractVersion).toBe(2);
    expect(policy.commandScopes["competition.round.prepare"]).toEqual(["judging"]);
    expect(policy.commandScopes["voting.ballot.submit"]).toEqual(["voting"]);

    const rounds = await db.selectFrom("competition_round").selectAll()
      .where("activity_id", "=", activity.id).execute();
    expect(rounds).toHaveLength(1);
    expect(rounds[0]).toMatchObject({ state: "prepared", release_version: 1 });

    // The old importer produced a running session that died on the first
    // command; the adopted release must execute immediately.
    const judging = await startExecution(db, defaultCapabilityRegistry, deps, {
      commandId: "adopt-judging-start",
      activityId: activity.id,
      scope: "judging",
      mode: "rehearsal",
    });
    expect(judging.status).toBe(201);
    const panel = await activateCompetitionPanel(db, deps, {
      commandId: "adopt-panel-activate",
      activityId: activity.id,
      roundId: rounds[0]!.id,
      scope: "judging",
      judges: [{ judgeId: "adopt-judge", seatKey: "seat-1" }],
    });
    expect(panel.status).toBe(201);

    const voting = await startExecution(db, defaultCapabilityRegistry, deps, {
      commandId: "adopt-voting-start",
      activityId: activity.id,
      scope: "voting",
      mode: "formal",
    });
    expect(voting.status).toBe(201);
    const opened = await openVoteSession(db, deps, {
      commandId: "adopt-vote-open",
      activityId: activity.id,
      sessionId: "adopt-vote-1",
      scope: "voting",
      candidateIds: ["legacy-user:1"],
    });
    expect(opened.status).toBe(201);
  });

  it("rejects adoption of an activity that already has a published result", async () => {
    const historic = { ...source, activity: { ...(source.activity as Record<string, unknown>), publicCode: "ADOPT-2" } };
    await expect(adoptLegacyBundle(db, deps, {
      commandId: "legacy-adopt-2",
      bundle: historic,
      dryRun: false,
      registry: defaultCapabilityRegistry,
      pack: SINGER_COMPETITION_PACK,
    })).rejects.toMatchObject({ code: "LEGACY_BUNDLE_INVALID" });
  });
});
