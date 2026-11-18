import type { ContractDescriptor } from "@artflow-plus/contracts";
import { getTeam, insertRelease } from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import {
  compileTeamsDefinition,
  createTeamsDefinition,
  DomainError,
  type ActorContext,
} from "@artflow-plus/domain";
import {
  addTeamMember,
  correctTeamRoster,
  createTeam,
  freezeTeamRoster,
  getTeamsView,
  withdrawTeamCommand,
} from "@artflow-plus/runtime";
import type { CommandOutcome } from "@artflow-plus/runtime";
import type { Kysely } from "kysely";

import type { ContractClock } from "../clock.js";
import { commandCounters, type CommandAdapter } from "../command.js";
import type { LifecycleAdapter, LifecycleOutcome, LifecycleState } from "../lifecycle.js";

export interface TeamsContractAdapter extends LifecycleAdapter {
  readonly descriptor: ContractDescriptor;
  readonly activityId: string;
  readonly staff: ActorContext;
  readonly outsider: ActorContext;
  readonly startCommand: CommandAdapter<{ readonly id: string; readonly status: string; readonly revision: number }>;
  rollbackDeps(): ReturnType<ContractClock["deps"]>;
}

export const TEAMS_CONTRACT_DESCRIPTOR: ContractDescriptor = {
  id: "teams",
  version: 1,
  kind: "lifecycle",
  provider: "teams.team.create",
  consumers: ["ops teams card"],
  preconditions: ["activity is active", "teams definition is released", "members are approved participants"],
  outputs: ["team", "team roster fingerprint", "Team* events"],
  invariants: [
    "a participant belongs to at most one active team",
    "the roster freezes only as a whole and then changes only through a correction",
    "a withdrawn team is terminal and keeps its key",
  ],
  errors: ["STALE_REVISION", "TEAM_EXISTS", "TEAM_MEMBER_EXISTS", "TEAM_ROSTER_FROZEN", "TEAM_WITHDRAWN"],
  sideEffects: ["command receipt", "audit entry", "outbox event"],
  idempotency: "the same command id and payload replays the stored body",
  concurrency: "activity row lock plus OCC on the team revision",
  recovery: "a withdrawn team releases its members; a correction replaces the frozen roster atomically",
};

const staff: ActorContext = {
  actorId: "teams-contract-staff",
  actorType: "user",
  roles: ["staff"],
  permissions: ["teams.manage", "teams.roster.correct"],
};

const outsider: ActorContext = {
  actorId: "teams-contract-outsider",
  actorType: "user",
  roles: ["participant"],
  permissions: [],
};

export function createTeamsContractAdapter(
  db: Kysely<Database>,
  clock: ContractClock,
): TeamsContractAdapter {
  let activityId = "";
  let teamId: string | undefined;
  const participantId = "contract-team-p1";

  const requireTeamId = (): string => {
    if (teamId === undefined) throw new Error("create must run before this command");
    return teamId;
  };

  const readTeam = async (): Promise<LifecycleState> => {
    if (teamId === undefined) return { status: "none", revision: 0 };
    const team = await getTeam(db, teamId);
    if (team === null) return { status: "none", revision: 0 };
    return { status: team.status, revision: team.revision };
  };

  const executeLifecycle = async (
    command: string,
    expectedRevision: number,
    commandId = `contract-teams-${command}-${clock.newEventId()}`,
  ): Promise<LifecycleOutcome> => {
    let outcome: CommandOutcome<unknown>;
    if (command === "create") {
      outcome = await createTeam(db, clock.deps(staff), {
        commandId,
        activityId,
        teamKey: "contract-team",
        name: "Contract team",
      });
      teamId = (outcome.body as { id: string }).id;
    } else if (command === "add-member") {
      outcome = await addTeamMember(db, clock.deps(staff), {
        commandId,
        activityId,
        teamId: requireTeamId(),
        participantId,
        role: "member",
        expectedRevision,
      });
    } else if (command === "freeze") {
      outcome = await freezeTeamRoster(db, clock.deps(staff), { commandId, activityId });
    } else if (command === "correct") {
      const view = await getTeamsView(db, clock.deps(staff), activityId);
      outcome = await correctTeamRoster(db, clock.deps(staff), {
        commandId,
        activityId,
        expectedRosterFingerprint: view.rosterFingerprint,
        reason: "contract correction",
        teams: view.teams
          .filter((team) => team.status !== "withdrawn")
          .map((team) => ({
            teamKey: team.teamKey,
            name: team.name,
            members: team.members.map((member) => ({
              participantId: member.participantId,
              role: member.role,
            })),
          })),
      });
    } else if (command === "withdraw") {
      outcome = await withdrawTeamCommand(db, clock.deps(staff), {
        commandId,
        activityId,
        teamId: requireTeamId(),
        expectedRevision,
        reason: "contract withdrawal",
      });
    } else {
      throw new Error(`Unknown teams lifecycle command: ${command}`);
    }
    const state = await readTeam();
    return {
      status: state.status,
      revision: state.revision,
      replayed: outcome.replayed,
      commandId,
    };
  };

  const startCommand: CommandAdapter<{ readonly id: string; readonly status: string; readonly revision: number }> = {
    name: "teams.team.create",
    get activityId() {
      return activityId;
    },
    actor: staff,
    commandType: "teams.team.create",
    capability: "teams",
    async execute({ commandId, actor }) {
      return createTeam(db, clock.deps(actor ?? staff), {
        commandId,
        activityId,
        teamKey: "contract-team",
        name: "Contract team",
      });
    },
    ...commandCounters(db, () => activityId),
  };

  return {
    name: "teams",
    provider: TEAMS_CONTRACT_DESCRIPTOR.provider,
    descriptor: TEAMS_CONTRACT_DESCRIPTOR,
    revisionMode: "required",
    lifecycle: {
      states: ["draft", "frozen", "withdrawn"],
      initial: "draft",
      terminal: ["withdrawn"],
      transitions: [
        { command: "create", from: "none", to: "draft", revisionDelta: 0 },
        { command: "add-member", from: "draft", to: "draft", revisionDelta: 1 },
        { command: "freeze", from: "draft", to: "frozen", revisionDelta: 1 },
        { command: "correct", from: "frozen", to: "frozen", revisionDelta: 1 },
        { command: "withdraw", from: "frozen", to: "withdrawn", revisionDelta: 1 },
      ],
    },
    variants: [
      {
        name: "withdraw-draft",
        transitions: [
          { command: "create", from: "none", to: "draft", revisionDelta: 0 },
          { command: "withdraw", from: "draft", to: "withdrawn", revisionDelta: 1 },
        ],
        terminal: ["withdrawn"],
      },
    ],
    illegal: [
      { command: "freeze", expectedRevision: 99, code: "INVALID_TRANSITION" },
      { command: "withdraw", expectedRevision: 99, code: "TEAM_WITHDRAWN" },
      { command: "correct", expectedRevision: 99, code: "TEAM_ROSTER_NOT_FROZEN" },
    ],
    get activityId() {
      return activityId;
    },
    staff,
    outsider,
    startCommand,
    rollbackDeps: () => clock.deps(staff),
    async setup() {
      activityId = `contract-teams-${clock.newEventId()}`;
      teamId = undefined;
      const artifact = compileTeamsDefinition(createTeamsDefinition({
        minSize: 1,
        maxSize: 3,
        requireCaptain: false,
        source: "manual",
      }));
      if (!artifact.ok) throw new Error(JSON.stringify(artifact));
      await db.insertInto("activity").values({
        id: activityId,
        title: "Contract teams",
        status: "active",
        revision: 1,
        enabled_capabilities: JSON.stringify(["registration", "teams"]),
        active_definition_version: 1,
      }).execute();
      await db.insertInto("registration").values({
        id: `registration-${activityId}-${participantId}`,
        activity_id: activityId,
        participant_id: participantId,
        questionnaire_version: "v1",
        questionnaire_hash: "contract-teams-hash",
        status: "approved",
        answers: JSON.stringify({ name: "Contract participant" }),
        revision: 1,
        review_note: "",
        reviewed_by: "contract",
        created_at: new Date(),
        updated_at: new Date(),
      }).execute();
      await insertRelease(db, {
        activityId,
        version: 1,
        contentHash: "contract-teams-release",
        capabilities: { teams: artifact },
        executionPolicy: {
          declaredScopes: [],
          conflicts: {},
          runtimeContractVersion: 2,
          commandScopes: {},
        },
        capabilityVersions: { teams: "1.0.0" },
        bindings: [],
        releasedAt: "2026-11-18T12:00:00Z",
        sourceDraftRevision: 1,
      });
    },
    execute: executeLifecycle,
    read: readTeam,
  };
}

/** Keeps the adapter honest about DomainError codes without importing the class twice. */
export function isDomainErrorOf(error: unknown, code: string): boolean {
  return error instanceof DomainError && error.code === code;
}
