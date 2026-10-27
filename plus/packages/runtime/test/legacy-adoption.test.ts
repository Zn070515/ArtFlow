import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  closeDb,
  createDb,
  getCurrentRankingSnapshot,
  migrate,
  selectPublicResults,
} from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import { defaultCapabilityRegistry, SINGER_COMPETITION_PACK, STAGE_SHOW_PACK } from "@artflow-plus/domain";
import type { ActorContext } from "@artflow-plus/domain";
import type { Kysely } from "kysely";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  activateCompetitionPanel,
  adoptLegacyBundle,
  buildPodiumCandidate,
  confirmStageResult,
  getPublicActivity,
  getRegistrationDetail,
  lockPerformance,
  lockRound,
  openPerformance,
  openVoteSession,
  recomputePodiumCandidate,
  releaseResult,
  resolveRound,
  startExecution,
  startRegistration,
  submitProxyScore,
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
    expect(result.report.semanticReady).toBe(true);
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
    expect(rounds[0]).toMatchObject({
      state: "prepared",
      release_version: 1,
      round_key: "round-21",
    });

    // The imported registration must resolve against the adopted questionnaire
    // snapshot, and a closed registration must stay closed.
    const importedRegistration = await db.selectFrom("registration").select("id")
      .where("activity_id", "=", activity.id).executeTakeFirstOrThrow();
    await expect(getRegistrationDetail(db, deps, activity.id, importedRegistration.id))
      .resolves.toMatchObject({ registration: { id: importedRegistration.id } });
    expect((await getPublicActivity(db, "ADOPT-1"))?.registrationOpen).toBe(false);
    await expect(startRegistration(db, deps, {
      commandId: "adopt-new-registration",
      activityId: activity.id,
      participantId: "late-participant",
    })).rejects.toMatchObject({ code: "REGISTRATION_CLOSED" });

    // The old importer produced a running session that died on the first
    // command; the adopted release must execute immediately.
    const judging = await startExecution(db, defaultCapabilityRegistry, deps, {
      commandId: "adopt-judging-start",
      activityId: activity.id,
      scope: "judging",
      mode: "formal",
    });
    expect(judging.status).toBe(201);
    const roundId = rounds[0]!.id;
    const panel = await activateCompetitionPanel(db, deps, {
      commandId: "adopt-panel-activate",
      activityId: activity.id,
      roundId,
      scope: "judging",
      judges: [{ judgeId: "adopt-judge", seatKey: "seat-1" }],
    });
    expect(panel.status).toBe(201);
    const seat = await db.selectFrom("judge_seat").select("id")
      .where("panel_id", "=", panel.body.id).executeTakeFirstOrThrow();
    const performance = await openPerformance(db, deps, {
      commandId: "adopt-performance-open",
      activityId: activity.id,
      roundId,
      contestantId: "legacy-user:1",
      sequence: 1,
      scope: "judging",
    });
    expect(performance.status).toBe(201);
    const scored = await submitProxyScore(db, deps, {
      commandId: "adopt-score",
      activityId: activity.id,
      roundId,
      performanceId: performance.body.id,
      panelSnapshotId: panel.body.id,
      seatId: seat.id,
      contextVersion: performance.body.contextVersion,
      criteria: { 总分: 90 },
      notes: "",
      sourceReference: "adoption-acceptance",
      reason: "adoption acceptance journey",
      scope: "judging",
    });
    expect(scored.status).toBe(201);
    await lockPerformance(db, deps, {
      commandId: "adopt-performance-lock",
      activityId: activity.id,
      roundId,
      performanceId: performance.body.id,
      scope: "judging",
    });
    const roundRow = await db.selectFrom("competition_round").selectAll()
      .where("id", "=", roundId).executeTakeFirstOrThrow();
    await lockRound(db, deps, {
      commandId: "adopt-round-lock",
      activityId: activity.id,
      roundId,
      expectedRevision: roundRow.revision,
      scope: "judging",
    });
    const ranking = await resolveRound(db, deps, {
      commandId: "adopt-resolve",
      activityId: activity.id,
      roundId,
      scope: "judging",
    });
    const lockedRound = await db.selectFrom("competition_round").selectAll()
      .where("id", "=", roundId).executeTakeFirstOrThrow();
    const rankingSnapshot = await getCurrentRankingSnapshot(db, roundId, "formal");
    expect(rankingSnapshot).not.toBeNull();
    const candidate = buildPodiumCandidate({
      requiredRoundIds: [roundId],
      rounds: [{
        roundId,
        sourceScoreVersion: lockedRound.score_version,
        locked: true,
        ranking: {
          status: rankingSnapshot!.status,
          rows: rankingSnapshot!.rows,
          tieGroups: rankingSnapshot!.tieGroups,
          inputFingerprint: rankingSnapshot!.inputFingerprint,
        } as Parameters<typeof buildPodiumCandidate>[0]["rounds"][number]["ranking"],
      }],
    });

    await startExecution(db, defaultCapabilityRegistry, deps, {
      commandId: "adopt-publishing-start",
      activityId: activity.id,
      scope: "publishing",
      mode: "formal",
    });
    const recomputed = await recomputePodiumCandidate(db, deps, {
      commandId: "adopt-podium",
      activityId: activity.id,
      roundIds: [roundId],
      expectedInputFingerprint: candidate.inputFingerprint,
      scope: "publishing",
    });
    expect(recomputed.status).toBe(201);
    const confirmed = await confirmStageResult(db, deps, {
      commandId: "adopt-confirm",
      activityId: activity.id,
      stageKey: "final_podium",
      scope: "publishing",
      expectedSourceRevision: recomputed.body.revision,
      expectedInputFingerprint: recomputed.body.inputFingerprint,
      awards: [{ award: "冠军", contestantId: "legacy-user:1" }],
      note: "adoption acceptance",
    });
    expect(confirmed.status).toBe(201);
    const released = await releaseResult(db, deps, {
      commandId: "adopt-release",
      activityId: activity.id,
      stageKey: "final_podium",
      scope: "publishing",
      expectedCandidateRevision: confirmed.body.candidateRevision,
      note: "adoption acceptance",
    });
    expect(released.status).toBe(201);
    const publicResults = await selectPublicResults(db, "ADOPT-1");
    expect(publicResults?.results).toHaveLength(1);
    expect(publicResults?.results[0]?.decisions[0]).toMatchObject({
      contestantId: "legacy-user:1",
    });

    // Voting is part of the adopted composition and can be opened immediately.
    await startExecution(db, defaultCapabilityRegistry, deps, {
      commandId: "adopt-voting-start",
      activityId: activity.id,
      scope: "voting",
      mode: "formal",
    });
    const opened = await openVoteSession(db, deps, {
      commandId: "adopt-vote-open",
      activityId: activity.id,
      sessionId: "adopt-vote-1",
      scope: "voting",
      candidateIds: ["legacy-user:1"],
    });
    expect(opened.status).toBe(201);
  });

  it("rejects a pack that cannot own the bundle facts", async () => {
    const current = {
      ...source,
      activity: { ...(source.activity as Record<string, unknown>), publicCode: "ADOPT-3" },
    };
    await expect(adoptLegacyBundle(db, deps, {
      commandId: "legacy-adopt-3",
      bundle: current,
      dryRun: false,
      registry: defaultCapabilityRegistry,
      pack: STAGE_SHOW_PACK,
    })).rejects.toMatchObject({ code: "LEGACY_BUNDLE_INVALID" });
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
