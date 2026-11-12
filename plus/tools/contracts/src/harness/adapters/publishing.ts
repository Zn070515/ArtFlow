import type { ContractDescriptor } from "@artflow-plus/contracts";
import { PUBLISHING_COMMAND_SCOPES } from "@artflow-plus/domain";
import type { ActorContext, ResultAward } from "@artflow-plus/domain";
import {
  insertPodiumCandidate,
  insertRelease,
  insertSession,
} from "@artflow-plus/db";
import type { Database, StoredStageResult } from "@artflow-plus/db";
import {
  confirmStageResult,
  releaseResult,
  revokeResultRelease,
  unlockStageResult,
} from "@artflow-plus/runtime";
import type { Kysely } from "kysely";

import type { ContractClock } from "../clock.js";
import { commandCounters, type CommandAdapter } from "../command.js";
import type {
  LifecycleAdapter,
  LifecycleOutcome,
  LifecycleState,
} from "../lifecycle.js";

export interface PublishingContractAdapter extends LifecycleAdapter {
  readonly descriptor: ContractDescriptor;
  readonly activityId: string;
  readonly staff: ActorContext;
  readonly outsider: ActorContext;
  readonly confirmCommand: CommandAdapter<StoredStageResult>;
}

export const PUBLISHING_CONTRACT_DESCRIPTOR: ContractDescriptor = {
  id: "publishing",
  version: 1,
  kind: "lifecycle",
  provider: "publishing.stage_result.confirm",
  consumers: ["public results", "program page", "archive package"],
  preconditions: ["formal publishing session", "latest podium candidate", "published release"],
  outputs: ["confirmed stage result", "active result release", "public snapshot"],
  invariants: [
    "a release is built from the latest confirmed candidate revision",
    "a confirmed result cannot change without an unlock",
    "only an active release can be revoked",
  ],
  errors: ["RESULT_NOT_CONFIRMED", "RESULT_ALREADY_RELEASED", "RESULT_RELEASE_NOT_ACTIVE", "STALE_RESOLUTION_INPUT"],
  sideEffects: ["command receipt", "audit entry", "outbox event"],
  idempotency: "the same command id and payload replays the stored body",
  concurrency: "the publishing activity lock serializes confirm, release, revoke, and unlock",
  recovery: "revoke the active release, then re-release the corrected candidate",
};

const staff: ActorContext = {
  actorId: "contract-publishing-staff",
  actorType: "user",
  roles: ["staff"],
  permissions: ["result.manage"],
};

const outsider: ActorContext = {
  actorId: "contract-publishing-outsider",
  actorType: "user",
  roles: ["participant"],
  permissions: [],
};

const placements = [
  { place: 1, contestantId: "singer-a", total: "98.30" },
  { place: 2, contestantId: "singer-b", total: "97.80" },
];

type PublishingPhase = "none" | "confirmed" | "active" | "revoked" | "ready_to_confirm";

/**
 * Publishing release lifecycle. Setup seeds the frozen podium candidate and
 * running formal publishing session a real operator would already have; the
 * commands below then exercise confirm, release, revoke, re-release, and a
 * correction unlock.
 */
export function createPublishingContractAdapter(
  db: Kysely<Database>,
  clock: ContractClock,
): PublishingContractAdapter {
  let activityId = "";
  let releaseId: string | undefined;
  let phase: PublishingPhase = "none";
  let revision = 0;

  const deps = () => clock.deps(staff);
  const stageKey = "final_podium";

  const requireRelease = (): string => {
    if (releaseId === undefined) throw new Error("release must run before revoke");
    return releaseId;
  };

  const record = <T extends { readonly status: string; readonly revision: number }>(
    body: T,
    outcome: { readonly replayed: boolean },
    commandId: string,
    nextPhase: PublishingPhase,
  ): LifecycleOutcome => {
    phase = nextPhase;
    revision = body.revision;
    return {
      status: phase,
      revision: body.revision,
      replayed: outcome.replayed,
      commandId,
    };
  };

  const executeLifecycle = async (
    command: string,
    _expectedRevision: number,
    commandId = `contract-publishing-${command}-${clock.newEventId()}`,
  ): Promise<LifecycleOutcome> => {
    if (command === "confirm") {
      const outcome = await confirmStageResult(db, deps(), {
        commandId,
        activityId,
        stageKey,
        scope: "publishing",
        expectedSourceRevision: 3,
        expectedInputFingerprint: "fp-1",
        awards: [{ award: "冠军", contestantId: "singer-a" }],
        note: "contract confirm",
      });
      return record(outcome.body, outcome, commandId, "confirmed");
    }
    if (command === "release") {
      const outcome = await releaseResult(db, deps(), {
        commandId,
        activityId,
        stageKey,
        scope: "publishing",
        expectedCandidateRevision: 3,
        note: "contract release",
      });
      releaseId = outcome.body.id;
      return record(outcome.body, outcome, commandId, "active");
    }
    if (command === "revoke") {
      const outcome = await revokeResultRelease(db, deps(), {
        commandId,
        activityId,
        releaseId: requireRelease(),
        scope: "publishing",
        note: "contract revoke",
      });
      return record(outcome.body, outcome, commandId, "revoked");
    }
    if (command === "revoke-missing") {
      const outcome = await revokeResultRelease(db, deps(), {
        commandId,
        activityId,
        releaseId: `missing-${clock.newEventId()}`,
        scope: "publishing",
        note: "contract revoke missing",
      });
      return record(outcome.body, outcome, commandId, "revoked");
    }
    if (command === "unlock") {
      const outcome = await unlockStageResult(db, deps(), {
        commandId,
        activityId,
        stageKey,
        scope: "publishing",
        expectedCandidateRevision: 3,
        note: "contract unlock",
      });
      return record(outcome.body, outcome, commandId, "ready_to_confirm");
    }
    throw new Error(`Unknown publishing lifecycle command: ${command}`);
  };

  const read = async (): Promise<LifecycleState> => ({ status: phase, revision });

  const confirmCommand: CommandAdapter<StoredStageResult> = {
    name: "publishing.confirm",
    get activityId() {
      return activityId;
    },
    actor: staff,
    commandType: "publishing.stage_result.confirm",
    capability: "publishing",
    async execute({ commandId, actor, payload }) {
      return confirmStageResult(db, clock.deps(actor ?? staff), {
        commandId,
        activityId,
        stageKey,
        scope: "publishing",
        expectedSourceRevision: 3,
        expectedInputFingerprint: "fp-1",
        awards: Array.isArray(payload) ? (payload as ResultAward[]) : [],
        note: "contract confirm",
      });
    },
    ...commandCounters(db, () => activityId),
  };

  return {
    name: "publishing",
    provider: PUBLISHING_CONTRACT_DESCRIPTOR.provider,
    descriptor: PUBLISHING_CONTRACT_DESCRIPTOR,
    revisionMode: "none",
    lifecycle: {
      states: ["confirmed", "active", "revoked", "ready_to_confirm"],
      initial: "confirmed",
      terminal: ["active"],
      transitions: [
        { command: "confirm", from: "none", to: "confirmed", revisionDelta: 0 },
        { command: "release", from: "confirmed", to: "active", revisionDelta: 1 },
      ],
    },
    variants: [
      {
        name: "revoke-and-re-release",
        transitions: [
          { command: "confirm", from: "none", to: "confirmed", revisionDelta: 0 },
          { command: "release", from: "confirmed", to: "active", revisionDelta: 1 },
          { command: "revoke", from: "active", to: "revoked", revisionDelta: 1 },
          { command: "release", from: "revoked", to: "active", revisionDelta: 1 },
        ],
        terminal: ["active"],
        illegal: [
          { command: "revoke-missing", expectedRevision: 0, code: "NOT_FOUND" },
        ],
      },
      {
        name: "correction-unlock",
        transitions: [
          { command: "confirm", from: "none", to: "confirmed", revisionDelta: 0 },
          { command: "release", from: "confirmed", to: "active", revisionDelta: 1 },
          { command: "revoke", from: "active", to: "revoked", revisionDelta: 1 },
          { command: "release", from: "revoked", to: "active", revisionDelta: 1 },
          { command: "unlock", from: "active", to: "ready_to_confirm", revisionDelta: 1 },
        ],
        terminal: ["ready_to_confirm"],
      },
    ],
    illegal: [
      { command: "release", expectedRevision: 0, code: "RESULT_ALREADY_RELEASED" },
      { command: "confirm", expectedRevision: 0, code: "INVALID_TRANSITION" },
    ],
    get activityId() {
      return activityId;
    },
    staff,
    outsider,
    confirmCommand,
    async setup() {
      activityId = `contract-publishing-${clock.newEventId()}`;
      phase = "none";
      revision = 0;
      releaseId = undefined;
      const roundId = `round-${activityId}`;
      await db.insertInto("activity").values({
        id: activityId,
        public_code: activityId,
        title: "Contract publishing",
        status: "active",
        revision: 1,
        enabled_capabilities: JSON.stringify(["competition", "publishing"]),
        active_definition_version: 1,
      }).execute();
      await db.insertInto("competition_round").values({
        id: roundId,
        activity_id: activityId,
        round_key: "final",
        release_version: 1,
        state: "locked",
        revision: 1,
        score_version: 1,
        minimum_judges: 1,
        judge_count: 1,
        completion_mode: "full_matrix",
        scoring_method: "average",
        advance_count: 0,
      }).execute();
      await insertRelease(db, {
        activityId,
        version: 1,
        contentHash: "contract-publishing-release",
        capabilities: {
          publishing: {
            ok: true,
            capabilityKey: "publishing",
            contentHash: "contract-publishing",
            artifact: {
              version: 1,
              schemaVersion: 1,
              stages: [{ key: stageKey, label: "Final podium" }],
            },
          },
        },
        executionPolicy: {
          declaredScopes: ["publishing"],
          conflicts: {},
          runtimeContractVersion: 2,
          commandScopes: PUBLISHING_COMMAND_SCOPES,
        },
        capabilityVersions: { publishing: "1" },
        bindings: [],
        releasedAt: "2026-11-12T12:00:00Z",
        sourceDraftRevision: 1,
      });
      await insertSession(db, {
        id: `publishing-${activityId}`,
        activityId,
        definitionVersion: 1,
        contentHash: "contract-publishing-release",
        scope: "publishing",
        mode: "formal",
        status: "running",
        revision: 0,
      }, "2026-11-12T12:00:00Z");
      await insertPodiumCandidate(db, {
        id: `podium-${activityId}`,
        activityId,
        inputFingerprint: "fp-1",
        status: "candidate",
        placements,
        sourceRoundIds: [roundId],
        sourceScoreVersions: [{ roundId, sourceScoreVersion: 1 }],
        revision: 3,
      });
    },
    execute: executeLifecycle,
    read,
  };
}
