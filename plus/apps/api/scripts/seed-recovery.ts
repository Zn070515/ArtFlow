import { randomUUID } from "node:crypto";

import {
  closeDb,
  createDb,
  insertPodiumCandidate,
  insertRegistration,
  insertRelease,
  insertResultPublication,
  insertResultRelease,
  insertSession,
  insertStageResult,
  migrate,
  upsertRoster,
} from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import {
  COMPETITION_COMMAND_SCOPES,
  PUBLISHING_COMMAND_SCOPES,
} from "@artflow-plus/domain";
import type { ActorContext } from "@artflow-plus/domain";
import {
  activateCompetitionPanel,
  lockPerformance,
  lockRound,
  openPerformance,
  prepareCompetitionRound,
  resolveRound,
  submitJudgeScore,
} from "@artflow-plus/runtime";
import type { RuntimeDeps } from "@artflow-plus/runtime";
import type { Kysely } from "kysely";
import { Client } from "pg";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (connectionString === undefined || connectionString.trim() === "") {
  throw new Error("ARTFLOW_PLUS_DATABASE_URL is required.");
}
const schema = process.env.ARTFLOW_PLUS_DB_SCHEMA;
if (schema !== undefined && !/^[a-z_][a-z0-9_]*$/.test(schema)) {
  throw new Error(`Unsafe ARTFLOW_PLUS_DB_SCHEMA: ${schema}`);
}

if (schema !== undefined) {
  const admin = new Client({ connectionString });
  await admin.connect();
  await admin.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
  await admin.end();
}

const db = createDb({
  connectionString,
  ...(schema === undefined ? {} : { schema }),
});
await migrate(db);

const activityId = "act_e2e_recovery";
const publicCode = "E2E-RECOVERY";
const title = "E2E Recovery";
const contentHash = "e2e-recovery-release";
const candidateId = "podium-e2e-recovery";
const inputFingerprint = "recovery-fingerprint";

const staff: ActorContext = {
  actorId: "e2e-ops",
  actorType: "user",
  roles: ["admin"],
  permissions: ["competition.manage", "competition.round.prepare"],
};
const judge: ActorContext = {
  actorId: "judge-1",
  actorType: "user",
  roles: ["judge"],
  permissions: [],
};

function deps(actor: ActorContext): RuntimeDeps {
  return {
    actor,
    now: () => new Date().toISOString(),
    newEventId: () => `recovery-${randomUUID()}`,
  };
}

async function resetActivity(db: Kysely<Database>): Promise<void> {
  const scoreFactIds = (
    await db.selectFrom("score_fact").select("id").where("activity_id", "=", activityId).execute()
  ).map((row) => row.id);
  const performanceIds = (
    await db.selectFrom("performance").select("id").where("activity_id", "=", activityId).execute()
  ).map((row) => row.id);
  const panelIds = (
    await db.selectFrom("panel_snapshot").select("id").where("activity_id", "=", activityId).execute()
  ).map((row) => row.id);

  await db.transaction().execute(async (trx) => {
    await trx.deleteFrom("result_release").where("activity_id", "=", activityId).execute();
    await trx.deleteFrom("result_publication").where("activity_id", "=", activityId).execute();
    await trx.deleteFrom("stage_result").where("activity_id", "=", activityId).execute();
    await trx.deleteFrom("tie_decision").where("activity_id", "=", activityId).execute();
    await trx.deleteFrom("advancement_decision").where("activity_id", "=", activityId).execute();
    await trx.deleteFrom("podium_candidate").where("activity_id", "=", activityId).execute();
    await trx.deleteFrom("ranking_snapshot").where("activity_id", "=", activityId).execute();
    if (scoreFactIds.length > 0) {
      await trx.deleteFrom("score_revision").where("score_fact_id", "in", scoreFactIds).execute();
      await trx.deleteFrom("score_correction").where("score_fact_id", "in", scoreFactIds).execute();
    }
    await trx.deleteFrom("score_fact").where("activity_id", "=", activityId).execute();
    if (performanceIds.length > 0) {
      await trx.deleteFrom("performance_score_state").where("performance_id", "in", performanceIds).execute();
    }
    await trx.deleteFrom("performance").where("activity_id", "=", activityId).execute();
    if (panelIds.length > 0) {
      await trx.deleteFrom("judge_seat").where("panel_id", "in", panelIds).execute();
      await trx.deleteFrom("panel_member").where("panel_id", "in", panelIds).execute();
    }
    await trx.deleteFrom("judge_session").where("activity_id", "=", activityId).execute();
    await trx.deleteFrom("judge_seat_grant").where("activity_id", "=", activityId).execute();
    await trx.deleteFrom("panel_snapshot").where("activity_id", "=", activityId).execute();
    await trx.deleteFrom("competition_round").where("activity_id", "=", activityId).execute();
    await trx.deleteFrom("execution_session").where("activity_id", "=", activityId).execute();
    await trx.deleteFrom("registration").where("activity_id", "=", activityId).execute();
    await trx.deleteFrom("roster").where("activity_id", "=", activityId).execute();
    await trx.deleteFrom("definition_release").where("activity_id", "=", activityId).execute();
    await trx.deleteFrom("audit_entry").where("activity_id", "=", activityId).execute();
    await trx.deleteFrom("command_receipt").where("activity_id", "=", activityId).execute();
    await trx.deleteFrom("outbox").where("activity_id", "=", activityId).execute();
    await trx.deleteFrom("activity").where("id", "=", activityId).execute();
  });
}

async function seedDefinition(): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await trx.insertInto("activity").values({
      id: activityId,
      public_code: publicCode,
      title,
      status: "active",
      revision: 1,
      enabled_capabilities: JSON.stringify(["competition", "publishing"]),
      active_definition_version: 1,
    }).execute();

    await insertRelease(trx, {
      activityId,
      version: 1,
      contentHash,
      capabilities: {
        competition: {
          ok: true,
          capabilityKey: "competition",
          contentHash: `${contentHash}-competition`,
          artifact: {
            order: ["roster", "final", "result"],
            nodes: [
              { key: "roster", type: "roster" },
              { key: "final", type: "round" },
              { key: "result", type: "output" },
            ],
            edges: [
              { from: "roster", to: "final" },
              { from: "final", to: "result" },
            ],
            rounds: [
              {
                key: "final",
                judgeCount: 1,
                minimumJudges: 1,
                completion: "minimum_valid",
                advanceCount: 1,
                scoringMethod: "average",
              },
            ],
            rubric: {
              criteria: [{ key: "total", weight: 1, maximum: 100, minimum: 0 }],
            },
            tiePolicy: "review",
          },
        },
        publishing: {
          ok: true,
          capabilityKey: "publishing",
          contentHash: `${contentHash}-publishing`,
          artifact: {
            version: 1,
            schemaVersion: 1,
            stages: [{ key: "final", label: "决赛" }],
          },
        },
      },
      executionPolicy: {
        declaredScopes: ["judging", "publishing"],
        conflicts: {},
        runtimeContractVersion: 2,
        commandScopes: { ...COMPETITION_COMMAND_SCOPES, ...PUBLISHING_COMMAND_SCOPES },
      },
      capabilityVersions: { competition: "1", publishing: "1" },
      bindings: [],
      releasedAt: new Date().toISOString(),
      sourceDraftRevision: 1,
    });

    await upsertRoster(trx, activityId, {
      status: "final",
      revision: 1,
      approvedCount: 3,
      finalizedAt: new Date().toISOString(),
    }, 0);

    for (const contestantId of ["singer-a", "singer-b", "singer-c"]) {
      await insertRegistration(trx, {
        id: `registration-${activityId}-${contestantId}`,
        activityId,
        participantId: contestantId,
        questionnaireVersion: "v1",
        questionnaireHash: "recovery-questionnaire",
        status: "approved",
        answers: {},
        revision: 1,
      });
    }

    await insertSession(trx, {
      id: `session-judging-${activityId}`,
      activityId,
      definitionVersion: 1,
      contentHash,
      scope: "judging",
      mode: "formal",
      status: "running",
      revision: 0,
    }, new Date().toISOString());

    await insertSession(trx, {
      id: `session-publishing-${activityId}`,
      activityId,
      definitionVersion: 1,
      contentHash,
      scope: "publishing",
      mode: "formal",
      status: "running",
      revision: 0,
    }, new Date().toISOString());
  });
}

async function seedRound(): Promise<{ readonly roundId: string; readonly scoreVersion: number }> {
  const round = await prepareCompetitionRound(db, deps(staff), {
    commandId: `recovery-prepare-${activityId}`,
    activityId,
    roundKey: "final",
    scope: "judging",
  });
  const roundId = round.body.id;
  const panel = await activateCompetitionPanel(db, deps(staff), {
    commandId: `recovery-panel-${activityId}`,
    activityId,
    roundId,
    scope: "judging",
    judges: [{ judgeId: judge.actorId, seatKey: "seat-1" }],
  });
  const seat = await db.selectFrom("judge_seat").selectAll()
    .where("panel_id", "=", panel.body.id)
    .where("judge_id", "=", judge.actorId)
    .executeTakeFirstOrThrow();

  for (const [index, [contestantId, total]] of ([
    ["singer-a", 90],
    ["singer-b", 90],
    ["singer-c", 80],
  ] as const).entries()) {
    const performance = await openPerformance(db, deps(staff), {
      commandId: `recovery-open-${activityId}-${contestantId}`,
      activityId,
      roundId,
      scope: "judging",
      contestantId,
      sequence: index + 1,
    });
    await submitJudgeScore(db, deps(judge), {
      commandId: `recovery-score-${activityId}-${contestantId}`,
      activityId,
      roundId,
      performanceId: performance.body.id,
      panelSnapshotId: panel.body.id,
      seatId: seat.id,
      contextVersion: 1,
      criteria: { total },
      notes: "",
      scope: "judging",
    });
    await lockPerformance(db, deps(staff), {
      commandId: `recovery-lock-performance-${activityId}-${contestantId}`,
      activityId,
      roundId,
      performanceId: performance.body.id,
      scope: "judging",
    });
  }

  const current = await db.selectFrom("competition_round").selectAll()
    .where("id", "=", roundId)
    .executeTakeFirstOrThrow();
  await lockRound(db, deps(staff), {
    commandId: `recovery-lock-round-${activityId}`,
    activityId,
    roundId,
    expectedRevision: current.revision,
    scope: "judging",
  });
  const ranking = await resolveRound(db, deps(staff), {
    commandId: `recovery-resolve-${activityId}`,
    activityId,
    roundId,
    scope: "judging",
  });
  const tieGroups = ranking.body.tieGroups as readonly {
    readonly contestants: readonly string[];
  }[];
  if (
    ranking.body.status !== "hold" ||
    tieGroups.length === 0 ||
    !["singer-a", "singer-b"].every((contestantId) =>
      tieGroups.some((group) => group.contestants.includes(contestantId)))
  ) {
    throw new Error("The recovery seed did not produce the expected crossing tie.");
  }
  return { roundId, scoreVersion: ranking.body.sourceScoreVersion };
}

async function seedResult(roundId: string, scoreVersion: number): Promise<void> {
  // Preset-world fixture: the candidate, confirmed stage result, publication and
  // release below are inserted directly so the journey starts from an already
  // published result. This pairing is not the state buildPodiumCandidate would
  // derive from the hold ranking seeded above; never build production
  // assertions on it.
  const decisions = [
    { rank: 1, contestantId: "singer-a", score: "90.00" },
    { rank: 2, contestantId: "singer-b", score: "90.00" },
    { rank: 3, contestantId: "singer-c", score: "80.00" },
  ];
  const awards: readonly { readonly award: string; readonly contestantId: string }[] = [];
  const stageResultId = "stage-result-e2e-recovery";
  const publicationId = "publication-e2e-recovery";
  const releasedAt = new Date().toISOString();

  await db.transaction().execute(async (trx) => {
    await insertPodiumCandidate(trx, {
      id: candidateId,
      activityId,
      inputFingerprint,
      status: "candidate",
      placements: decisions.map((decision) => ({
        place: decision.rank,
        contestantId: decision.contestantId,
        total: decision.score,
      })),
      sourceRoundIds: [roundId],
      sourceScoreVersions: [{ roundId, sourceScoreVersion: scoreVersion }],
      revision: 3,
    });

    await insertStageResult(trx, {
      id: stageResultId,
      activityId,
      stageKey: "final",
      status: "confirmed",
      candidateRevision: 3,
      sourceCandidateRevision: 3,
      inputFingerprint,
      source: {
        kind: "podium_candidate",
        aggregateId: candidateId,
        definitionVersion: 1,
        releaseHash: contentHash,
        mode: "formal",
        sourceRevision: 3,
        inputFingerprint,
        dependencyIds: [roundId],
        dependencyRefs: [`round:${roundId}`],
      },
      decisions,
      awards,
      note: "seed",
      revision: 1,
      confirmedAt: releasedAt,
      staleReason: "",
    });

    await insertResultPublication(trx, {
      id: publicationId,
      activityId,
      stageKey: "final",
      title: `${title} · 决赛`,
      content: "",
      version: 1,
      revision: 0,
    });

    await insertResultRelease(trx, {
      id: "release-e2e-recovery",
      activityId,
      publicationId,
      stageResultId,
      stageKey: "final",
      status: "active",
      snapshot: {
        activityTitle: title,
        publicTitle: `${title} · 决赛`,
        stageKey: "final",
        decisions,
        awards,
      },
      snapshotCandidateRevision: 3,
      resultVersion: 3,
      postVersion: 1,
      inputFingerprint,
      note: "seed",
      releasedAt,
      revision: 0,
    });
  });
}

await resetActivity(db);
await seedDefinition();
const { roundId, scoreVersion } = await seedRound();
await seedResult(roundId, scoreVersion);

await closeDb(db);
console.log(`Seeded live exception recovery activity ${activityId} (${publicCode}).`);
