import type { ContractDescriptor } from "@artflow-plus/contracts";
import { COMPETITION_COMMAND_SCOPES } from "@artflow-plus/domain";
import type { ActorContext } from "@artflow-plus/domain";
import {
  insertRelease,
  insertSession,
} from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import {
  activateCompetitionPanel,
  lockPerformance,
  lockRound,
  openPerformance,
  prepareCompetitionRound,
  reopenRoundForCorrection,
  submitRapidScore,
} from "@artflow-plus/runtime";
import type { Kysely } from "kysely";

import type { ContractClock } from "../clock.js";
import { commandCounters, type CommandAdapter } from "../command.js";
import type {
  LifecycleAdapter,
  LifecycleOutcome,
  LifecycleState,
} from "../lifecycle.js";

export interface CompetitionContractAdapter extends LifecycleAdapter {
  readonly descriptor: ContractDescriptor;
  readonly activityId: string;
  readonly contestantId: string;
  readonly staff: ActorContext;
  readonly outsider: ActorContext;
  readonly prepareCommand: CommandAdapter<{ readonly id: string }>;
}

export const COMPETITION_CONTRACT_DESCRIPTOR: ContractDescriptor = {
  id: "competition",
  version: 1,
  kind: "lifecycle",
  provider: "competition.round.prepare",
  consumers: ["live console", "judge entry", "publishing candidate"],
  preconditions: ["final roster", "running judging session", "published competition release"],
  outputs: ["prepared round", "panel snapshot", "score facts", "ranking snapshot"],
  invariants: [
    "a round locks only after every performance score gate is locked",
    "scores bind to the current panel, seat, and context version",
    "reopening a locked round requires a reason and a formal session",
  ],
  errors: ["ROUND_LOCKED", "PERFORMANCE_NOT_SCORABLE", "STALE_REVISION", "FORMAL_MODE_REQUIRED"],
  sideEffects: ["command receipt", "audit entry", "outbox event"],
  idempotency: "the same command id and payload replays the stored body",
  concurrency: "round revision gates every transition; duplicate score facts are rejected",
  recovery: "a locked round reopens for correction, then locks again after recalculation",
};

const staff: ActorContext = {
  actorId: "contract-competition-staff",
  actorType: "user",
  roles: ["staff"],
  permissions: ["competition.manage", "competition.round.prepare", "competition.score.write"],
};

const outsider: ActorContext = {
  actorId: "contract-competition-outsider",
  actorType: "user",
  roles: ["participant"],
  permissions: [],
};

const competitionArtifact = {
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
  rubric: { criteria: [{ key: "total", weight: 1, maximum: 100, minimum: 0 }] },
  tiePolicy: "review",
};

/**
 * Competition round lifecycle. Setup seeds the durable rows a real operator
 * would have produced before the first command (release, final roster, running
 * judging session); every transition below then runs through the public runtime
 * command, including the score that closes the performance gate.
 */
export function createCompetitionContractAdapter(
  db: Kysely<Database>,
  clock: ContractClock,
): CompetitionContractAdapter {
  let activityId = "";
  let contestantId = "";
  let roundId: string | undefined;

  const roundState = async (): Promise<LifecycleState> => {
    if (roundId === undefined) return { status: "none", revision: 0 };
    const row = await db
      .selectFrom("competition_round")
      .select(["state", "revision"])
      .where("id", "=", roundId)
      .executeTakeFirstOrThrow();
    return { status: row.state, revision: row.revision };
  };

  const requireRoundId = (): string => {
    if (roundId === undefined) throw new Error("prepare must run before this command");
    return roundId;
  };

  const executeLifecycle = async (
    command: string,
    expectedRevision: number,
    commandId = `contract-competition-${command}-${clock.newEventId()}`,
  ): Promise<LifecycleOutcome> => {
    const deps = clock.deps(staff);
    if (command === "prepare") {
      const outcome = await prepareCompetitionRound(db, deps, {
        commandId,
        activityId,
        roundKey: "final",
        scope: "judging",
      });
      roundId = outcome.body.id;
    } else if (command === "panel") {
      await activateCompetitionPanel(db, deps, {
        commandId,
        activityId,
        roundId: requireRoundId(),
        scope: "judging",
        judges: [{ judgeId: "judge-1", seatKey: "seat-1" }],
      });
    } else if (command === "open") {
      await openPerformance(db, deps, {
        commandId,
        activityId,
        roundId: requireRoundId(),
        scope: "judging",
        contestantId,
        sequence: 1,
      });
    } else if (command === "score") {
      const round = requireRoundId();
      const panel = await db
        .selectFrom("panel_snapshot")
        .select(["id"])
        .where("round_id", "=", round)
        .where("current", "=", true)
        .executeTakeFirstOrThrow();
      const seat = await db
        .selectFrom("judge_seat")
        .select(["id"])
        .where("panel_id", "=", panel.id)
        .where("judge_id", "=", "judge-1")
        .executeTakeFirstOrThrow();
      const performance = await db
        .selectFrom("performance")
        .select(["id", "context_version"])
        .where("round_id", "=", round)
        .where("contestant_id", "=", contestantId)
        .executeTakeFirstOrThrow();
      await submitRapidScore(db, deps, {
        commandId,
        activityId,
        roundId: round,
        performanceId: performance.id,
        panelSnapshotId: panel.id,
        seatId: seat.id,
        contextVersion: performance.context_version,
        criteria: { total: 90 },
        scope: "judging",
      });
    } else if (command === "lock-performance") {
      const performance = await db
        .selectFrom("performance")
        .select(["id"])
        .where("round_id", "=", requireRoundId())
        .where("contestant_id", "=", contestantId)
        .executeTakeFirstOrThrow();
      await lockPerformance(db, deps, {
        commandId,
        activityId,
        roundId: requireRoundId(),
        performanceId: performance.id,
        scope: "judging",
      });
    } else if (command === "lock") {
      await lockRound(db, deps, {
        commandId,
        activityId,
        roundId: requireRoundId(),
        expectedRevision,
        scope: "judging",
      });
    } else if (command === "reopen") {
      await reopenRoundForCorrection(db, deps, {
        commandId,
        activityId,
        roundId: requireRoundId(),
        expectedRevision,
        scope: "judging",
        reason: "contract correction",
      });
    } else {
      throw new Error(`Unknown competition lifecycle command: ${command}`);
    }
    const state = await roundState();
    return { ...state, replayed: false, commandId };
  };

  const prepareCommand: CommandAdapter<{ readonly id: string }> = {
    name: "competition.prepare",
    get activityId() {
      return activityId;
    },
    actor: staff,
    commandType: "competition.round.prepare",
    capability: "competition",
    async execute({ commandId, actor, payload }) {
      const outcome = await prepareCompetitionRound(db, clock.deps(actor ?? staff), {
        commandId,
        activityId,
        roundKey: typeof payload === "string" ? payload : "final",
        scope: "judging",
      });
      roundId = outcome.body.id;
      return outcome;
    },
    ...commandCounters(db, () => activityId),
  };

  return {
    name: "competition",
    provider: COMPETITION_CONTRACT_DESCRIPTOR.provider,
    descriptor: COMPETITION_CONTRACT_DESCRIPTOR,
    revisionMode: "required",
    lifecycle: {
      states: ["prepared", "scoring", "locked"],
      initial: "prepared",
      terminal: ["locked"],
      transitions: [
        { command: "prepare", from: "none", to: "prepared", revisionDelta: 0 },
        { command: "panel", from: "prepared", to: "scoring", revisionDelta: 1 },
        { command: "open", from: "scoring", to: "scoring", revisionDelta: 1 },
        { command: "score", from: "scoring", to: "scoring", revisionDelta: 1 },
        { command: "lock-performance", from: "scoring", to: "scoring", revisionDelta: 1 },
        { command: "lock", from: "scoring", to: "locked", revisionDelta: 1 },
        { command: "reopen", from: "locked", to: "scoring", revisionDelta: 1 },
        { command: "lock", from: "scoring", to: "locked", revisionDelta: 1 },
      ],
    },
    illegal: [
      { command: "lock", expectedRevision: 7, code: "ROUND_LOCKED" },
      { command: "open", expectedRevision: 0, code: "ROUND_NOT_PREPARED" },
      { command: "reopen", expectedRevision: 99, code: "STALE_REVISION" },
      { command: "prepare", expectedRevision: 0, code: "ROUND_ALREADY_PREPARED" },
    ],
    get activityId() {
      return activityId;
    },
    get contestantId() {
      return contestantId;
    },
    staff,
    outsider,
    prepareCommand,
    async setup() {
      activityId = `contract-competition-${clock.newEventId()}`;
      contestantId = `contract-contestant-${clock.newEventId()}`;
      roundId = undefined;
      await db.insertInto("activity").values({
        id: activityId,
        public_code: activityId,
        title: "Contract competition",
        status: "active",
        revision: 1,
        enabled_capabilities: JSON.stringify(["competition", "ticketing"]),
        active_definition_version: 1,
      }).execute();
      await insertRelease(db, {
        activityId,
        version: 1,
        contentHash: "contract-competition-release",
        capabilities: {
          competition: {
            ok: true,
            capabilityKey: "competition",
            contentHash: "contract-competition",
            artifact: competitionArtifact,
          },
          ticketing: {
            ok: true,
            capabilityKey: "ticketing",
            contentHash: "contract-ticketing",
            artifact: { schemaVersion: 1 },
          },
        },
        executionPolicy: {
          declaredScopes: ["judging"],
          conflicts: {},
          runtimeContractVersion: 2,
          commandScopes: COMPETITION_COMMAND_SCOPES,
        },
        capabilityVersions: { competition: "1", ticketing: "1" },
        bindings: [],
        releasedAt: "2026-11-12T12:00:00Z",
        sourceDraftRevision: 1,
      });
      await insertSession(db, {
        id: `session-${activityId}`,
        activityId,
        definitionVersion: 1,
        contentHash: "contract-competition-release",
        scope: "judging",
        mode: "formal",
        status: "running",
        revision: 0,
      }, "2026-11-12T12:00:00Z");
      await db.insertInto("roster").values({
        activity_id: activityId,
        status: "final",
        approved_count: 1,
        revision: 1,
        finalized_at: "2026-11-12T12:00:00Z",
        updated_at: new Date(),
      }).execute();
      await db.insertInto("registration").values({
        id: `registration-${activityId}`,
        activity_id: activityId,
        participant_id: contestantId,
        questionnaire_version: "v1",
        questionnaire_hash: "contract-questionnaire",
        status: "approved",
        answers: JSON.stringify({ name: "Contract Contestant" }),
        revision: 1,
        review_note: "",
        reviewed_by: staff.actorId,
        created_at: new Date(),
        updated_at: new Date(),
      }).execute();
    },
    execute: executeLifecycle,
    read: roundState,
  };
}
