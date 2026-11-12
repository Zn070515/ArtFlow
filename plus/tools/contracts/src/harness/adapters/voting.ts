import type { ContractDescriptor } from "@artflow-plus/contracts";
import { insertRelease, insertSession } from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import { VOTING_COMMAND_SCOPES } from "@artflow-plus/domain";
import type { ActorContext, ExecutionMode, ExecutionSession } from "@artflow-plus/domain";
import { closeVoteSession, openVoteSession, submitBallot } from "@artflow-plus/runtime";
import type { CommandOutcome } from "@artflow-plus/runtime";
import type { Kysely } from "kysely";

import type { ContractClock } from "../clock.js";
import { commandCounters, type CommandAdapter } from "../command.js";
import type { LifecycleAdapter, LifecycleOutcome, LifecycleState } from "../lifecycle.js";

interface OpenVoteBody {
  readonly session: { readonly status: string; readonly revision: number };
  readonly options: readonly { readonly id: string }[];
}

export interface VotingContractAdapter extends LifecycleAdapter {
  readonly descriptor: ContractDescriptor;
  readonly activityId: string;
  readonly staff: ActorContext;
  readonly viewer: ActorContext;
  readonly openCommand: CommandAdapter<OpenVoteBody>;
  submit(commandId: string, fingerprint: string): Promise<CommandOutcome<unknown>>;
  ballotCount(): Promise<number>;
  staleRelease(): Promise<void>;
  modeChanged(mode: ExecutionMode): Promise<void>;
}

export const VOTING_CONTRACT_DESCRIPTOR: ContractDescriptor = {
  id: "voting",
  version: 1,
  kind: "lifecycle",
  provider: "voting.session.open",
  consumers: ["ops voting card", "public vote page", "publishing vote result"],
  preconditions: ["activity is active", "voting execution session is running"],
  outputs: ["open vote session", "frozen options"],
  invariants: [
    "a ballot is unique per identity",
    "a ballot must match the session release and mode",
    "a closed session rejects new ballots",
  ],
  errors: ["DUPLICATE_BALLOT", "STALE_CONTEXT", "VOTE_SESSION_CLOSED", "INVALID_TICKET"],
  sideEffects: ["command receipt", "audit entry", "outbox event"],
  idempotency: "the same command id and payload replays the stored body",
  concurrency: "the ballot uniqueness constraint and session lock serialize duplicates",
  recovery: "retry the same command id; stale execution sessions must be reopened",
};

const staff: ActorContext = {
  actorId: "contract-voting-staff",
  actorType: "user",
  roles: ["staff"],
  permissions: ["voting.manage"],
};

const viewer: ActorContext = {
  actorId: "contract-voting-viewer",
  actorType: "user",
  roles: [],
  permissions: [],
};

const votingArtifact = {
  version: 2,
  schemaVersion: 2,
  purpose: "score_component",
  selectionType: "single",
  maxSelections: 1,
  identityPolicy: "browser",
  scoringRule: { kind: "ballot_share_percent", scale: 100, decimals: 2 },
} as const;

export function createVotingContractAdapter(
  db: Kysely<Database>,
  clock: ContractClock,
): VotingContractAdapter {
  let activityId = "";
  let voteSessionId = "";
  let optionId: string | undefined;
  let executionId = "";

  const deps = (actor: ActorContext) => clock.deps(actor);

  async function insertRunningSession(mode: ExecutionMode, definitionVersion = 1): Promise<void> {
    executionId = `contract-voting-exec-${clock.newEventId()}`;
    const session: ExecutionSession = {
      id: executionId,
      activityId,
      definitionVersion,
      contentHash: definitionVersion === 1 ? "contract-voting-release" : `contract-voting-release-v${definitionVersion}`,
      scope: "voting",
      mode,
      status: "running",
      revision: 0,
    };
    await insertSession(db, session, "2026-11-11T12:00:00Z");
  }

  async function closeRunningSession(): Promise<void> {
    await db.updateTable("execution_session")
      .set({ status: "closed", revision: 1 })
      .where("id", "=", executionId)
      .execute();
  }

  async function insertVotingRelease(
    version: number,
    contentHash: string,
    sourceDraftRevision: number,
  ): Promise<void> {
    await insertRelease(db, {
      activityId,
      version,
      contentHash,
      capabilities: {
        voting: {
          ok: true,
          capabilityKey: "voting",
          contentHash: "voting",
          artifact: votingArtifact,
        },
      },
      executionPolicy: {
        declaredScopes: ["voting"],
        conflicts: {},
        runtimeContractVersion: 2,
        commandScopes: VOTING_COMMAND_SCOPES,
      },
      capabilityVersions: { voting: "1" },
      bindings: [],
      releasedAt: version === 1 ? "2026-11-11T12:00:00Z" : "2026-11-11T12:01:00Z",
      sourceDraftRevision,
    });
  }

  async function open(
    commandId: string,
    actor: ActorContext,
    candidateIds: readonly string[],
  ): Promise<CommandOutcome<OpenVoteBody>> {
    const outcome = await openVoteSession(db, deps(actor), {
      commandId,
      activityId,
      sessionId: voteSessionId,
      scope: "voting",
      candidateIds,
    });
    optionId = outcome.body.options[0]?.id;
    return outcome;
  }

  const openCommand: CommandAdapter<OpenVoteBody> = {
    name: "voting.session.open",
    get activityId() {
      return activityId;
    },
    actor: staff,
    commandType: "voting.session.open",
    capability: "voting",
    async execute({ commandId, actor, payload }) {
      const candidateIds = (payload as { readonly candidateIds?: readonly string[] } | undefined)?.candidateIds
        ?? ["candidate-a", "candidate-b"];
      return open(commandId, actor ?? staff, candidateIds);
    },
    ...commandCounters(db, () => activityId),
  };

  const executeLifecycle = async (
    command: string,
    expectedRevision: number,
    commandId = `contract-voting-${command}-${clock.newEventId()}`,
  ): Promise<LifecycleOutcome> => {
    if (command === "open") {
      const outcome = await open(commandId, staff, ["candidate-a", "candidate-b"]);
      return {
        status: outcome.body.session.status,
        revision: outcome.body.session.revision,
        replayed: outcome.replayed,
        commandId,
      };
    }
    if (command === "close") {
      const outcome = await closeVoteSession(db, deps(staff), {
        commandId,
        activityId,
        sessionId: voteSessionId,
        scope: "voting",
        expectedRevision,
      });
      return {
        status: outcome.body.status,
        revision: outcome.body.revision,
        replayed: outcome.replayed,
        commandId,
      };
    }
    throw new Error(`Unknown voting lifecycle command: ${command}`);
  };

  const read = async (): Promise<LifecycleState> => {
    const row = await db.selectFrom("vote_session")
      .select(["status", "revision"])
      .where("id", "=", voteSessionId)
      .executeTakeFirst();
    return row === undefined ? { status: "none", revision: 0 } : { status: row.status, revision: row.revision };
  };

  return {
    name: "voting",
    provider: VOTING_CONTRACT_DESCRIPTOR.provider,
    descriptor: VOTING_CONTRACT_DESCRIPTOR,
    revisionMode: "required",
    lifecycle: {
      states: ["open", "closed"],
      initial: "open",
      terminal: ["closed"],
      transitions: [
        { command: "open", from: "none", to: "open", revisionDelta: 0 },
        { command: "close", from: "open", to: "closed", revisionDelta: 1 },
      ],
    },
    illegal: [
      { command: "close", expectedRevision: 1, code: "VOTE_SESSION_CLOSED" },
      { command: "open", expectedRevision: 1, code: "INVALID_TRANSITION" },
    ],
    get activityId() {
      return activityId;
    },
    staff,
    viewer,
    openCommand,
    async setup() {
      activityId = `contract-voting-${clock.newEventId()}`;
      voteSessionId = `contract-vote-${clock.newEventId()}`;
      optionId = undefined;
      await db.insertInto("activity").values({
        id: activityId,
        public_code: activityId,
        title: "Contract voting",
        status: "active",
        revision: 1,
        enabled_capabilities: JSON.stringify(["voting"]),
        active_definition_version: 1,
      }).execute();
      await insertVotingRelease(1, "contract-voting-release", 1);
      await insertRunningSession("formal");
    },
    execute: executeLifecycle,
    read,
    async submit(commandId, fingerprint) {
      if (optionId === undefined) throw new Error("open must run first");
      return submitBallot(db, deps(staff), {
        commandId,
        activityId,
        sessionId: voteSessionId,
        scope: "voting",
        optionIds: [optionId],
        identity: { type: "browser", fingerprint },
      });
    },
    async ballotCount() {
      const row = await db.selectFrom("ballot")
        .select((expression) => expression.fn.countAll<number>().as("count"))
        .where("session_id", "=", voteSessionId)
        .executeTakeFirstOrThrow();
      return Number(row.count);
    },
    async staleRelease() {
      await closeRunningSession();
      await insertVotingRelease(2, "contract-voting-release-v2", 2);
      await db.updateTable("activity")
        .set({ active_definition_version: 2, revision: 2 })
        .where("id", "=", activityId)
        .execute();
      await insertRunningSession("formal", 2);
    },
    async modeChanged(mode) {
      await closeRunningSession();
      await insertRunningSession(mode);
    },
  };
}
