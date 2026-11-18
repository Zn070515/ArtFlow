import type {
  Database,
  StoredRelease,
  StoredTeam,
  StoredTeamMember,
  StoredTeamMemberRole,
  StoredTeamSource,
} from "@artflow-plus/db";
import {
  bumpTeamRevision,
  closeTeamMembers,
  correctTeam,
  findActiveMembership,
  freezeTeam,
  getActivityForUpdate,
  getActivitySummary,
  getGroupingStageByKey,
  getRelease,
  getTeamForUpdate,
  insertTeam,
  insertTeamMember,
  listActiveMembers,
  listApprovedParticipantIds,
  listCurrentGroupingMemberships,
  listGroupingGroups,
  listTeams,
  listTeamsForUpdate,
  removeTeamMember,
  selectParticipantNames,
  updateTeamName,
  withdrawTeam,
} from "@artflow-plus/db";
import {
  DomainError,
  hasPermission,
  requirePermission,
  type CompiledTeamsArtifact,
  type TeamMemberRole,
} from "@artflow-plus/domain";
import type { Kysely } from "kysely";

import { executeCommand, type CommandOutcome } from "./command.js";
import { runtimeActor, type RuntimeDeps } from "./deps.js";
import { appendEngineEvent } from "./events.js";
import { idFromCommand, stableHash } from "./hash.js";

const READ_PERMISSIONS = ["teams.manage", "teams.roster.correct", "studio.manage"];
const KEY_PATTERN = /^[a-z0-9-]{1,40}$/;

function teamsArtifact(release: StoredRelease): CompiledTeamsArtifact {
  const plan = release.capabilities.teams;
  if (plan === undefined || plan.ok !== true) {
    throw new DomainError("RELEASE_SNAPSHOT_INCOMPLETE", "The release has no teams snapshot.");
  }
  const artifact = plan.artifact;
  if (
    typeof artifact !== "object" || artifact === null ||
    (artifact as { schemaVersion?: unknown }).schemaVersion !== 1
  ) {
    throw new DomainError("RELEASE_SNAPSHOT_INCOMPLETE", "The teams release snapshot is invalid.");
  }
  return artifact as CompiledTeamsArtifact;
}

async function currentTeams(
  db: Kysely<Database>,
  activity: {
    readonly id: string;
    readonly activeDefinitionVersion: number;
    readonly enabledCapabilities: readonly string[];
  },
): Promise<{ readonly release: StoredRelease; readonly artifact: CompiledTeamsArtifact }> {
  if (!activity.enabledCapabilities.includes("teams")) {
    throw new DomainError("CAPABILITY_DISABLED", "The teams capability is not enabled.");
  }
  const release = await getRelease(db, activity.id, activity.activeDefinitionVersion);
  if (release === null) throw new DomainError("VERSION_NOT_RELEASED", "The activity has no active released definition.");
  return { release, artifact: teamsArtifact(release) };
}

function requireRead(actor: ReturnType<typeof runtimeActor>): void {
  if (!READ_PERMISSIONS.some((permission) => hasPermission(actor, permission))) {
    throw new DomainError("FORBIDDEN", "A teams or studio permission is required.");
  }
}

function requireActive(activity: { readonly status: string }): void {
  if (activity.status !== "active") {
    throw new DomainError("ACTIVITY_NOT_ACTIVE", "Only an active activity can change its team roster.");
  }
}

function normalizeKey(value: string): string {
  const key = value.trim();
  if (!KEY_PATTERN.test(key)) {
    throw new DomainError("INVALID_INPUT", "Team key must be 1-40 lowercase letters, numbers or dashes.");
  }
  return key;
}

function normalizeName(value: string): string {
  const name = value.trim();
  if (name === "" || name.length > 80) {
    throw new DomainError("INVALID_INPUT", "Team name must be 1-80 characters.");
  }
  return name;
}

function normalizeReason(value: string): string {
  const reason = value.trim();
  if (reason === "") throw new DomainError("CORRECTION_REQUIRED", "A reason is required.");
  if (reason.length > 1000) throw new DomainError("INVALID_INPUT", "The reason must be at most 1000 characters.");
  return reason;
}

function normalizeRole(value: string): TeamMemberRole {
  if (value !== "member" && value !== "captain") {
    throw new DomainError("INVALID_INPUT", "Member role must be member or captain.");
  }
  return value;
}

async function approvedParticipants(
  db: Kysely<Database>,
  activityId: string,
): Promise<{ readonly ids: ReadonlySet<string>; readonly labels: ReadonlyMap<string, string> }> {
  const ids = await listApprovedParticipantIds(db, activityId);
  const labels = await selectParticipantNames(db, activityId, ids);
  return { ids: new Set(ids), labels };
}

function requireApproved(approved: ReadonlySet<string>, participantId: string): void {
  if (!approved.has(participantId)) {
    throw new DomainError("TEAM_MEMBER_UNKNOWN", "A team member must be an approved participant of this activity.");
  }
}

function membersFor(teamId: string, members: readonly StoredTeamMember[]): readonly StoredTeamMember[] {
  return members
    .filter((member) => member.teamId === teamId)
    .sort((left, right) => left.participantId.localeCompare(right.participantId));
}

function rosterFingerprint(
  teams: readonly StoredTeam[],
  members: readonly StoredTeamMember[],
): string {
  return stableHash({
    teams: teams
      .filter((team) => team.status !== "withdrawn")
      .sort((left, right) => left.teamKey.localeCompare(right.teamKey))
      .map((team) => ({
        key: team.teamKey,
        name: team.name,
        status: team.status,
        members: membersFor(team.id, members).map((member) => ({
          participantId: member.participantId,
          role: member.role,
        })),
      })),
  });
}

function validateTeamSize(artifact: CompiledTeamsArtifact, count: number, name: string): void {
  if (count < artifact.minSize || count > artifact.maxSize) {
    throw new DomainError(
      "TEAM_SIZE_INVALID",
      `Team ${name} must have between ${artifact.minSize} and ${artifact.maxSize} members.`,
    );
  }
}

function validateCaptains(
  artifact: CompiledTeamsArtifact,
  members: readonly { readonly role: TeamMemberRole }[],
  name: string,
): void {
  const captains = members.filter((member) => member.role === "captain").length;
  if (captains > 1) throw new DomainError("TEAM_CAPTAIN_REQUIRED", `Team ${name} can have at most one captain.`);
  if (artifact.requireCaptain && captains !== 1) {
    throw new DomainError("TEAM_CAPTAIN_REQUIRED", `Team ${name} needs exactly one captain.`);
  }
}

export interface TeamMemberView {
  readonly participantId: string;
  readonly name: string;
  readonly role: TeamMemberRole;
  readonly addedAt: string;
}

export interface TeamView {
  readonly id: string;
  readonly teamKey: string;
  readonly name: string;
  readonly status: StoredTeam["status"];
  readonly source: StoredTeamSource;
  readonly revision: number;
  readonly members: readonly TeamMemberView[];
  readonly withdrawnAt?: string;
  readonly withdrawReason?: string;
}

export interface TeamParticipantOption {
  readonly participantId: string;
  readonly name: string;
}

export interface TeamsView {
  readonly activityId: string;
  readonly definitionVersion: number;
  readonly definition: CompiledTeamsArtifact;
  readonly rosterFingerprint: string;
  readonly rosterFrozen: boolean;
  readonly teams: readonly TeamView[];
  readonly participants: readonly TeamParticipantOption[];
}

function teamViews(
  teams: readonly StoredTeam[],
  members: readonly StoredTeamMember[],
  labels: ReadonlyMap<string, string>,
): readonly TeamView[] {
  return teams.map((team) => ({
    id: team.id,
    teamKey: team.teamKey,
    name: team.name,
    status: team.status,
    source: team.source,
    revision: team.revision,
    members: membersFor(team.id, members).map((member) => ({
      participantId: member.participantId,
      name: labels.get(member.participantId) ?? member.participantId,
      role: member.role,
      addedAt: member.addedAt,
    })),
    ...(team.withdrawnAt === undefined ? {} : { withdrawnAt: team.withdrawnAt }),
    ...(team.withdrawReason === undefined ? {} : { withdrawReason: team.withdrawReason }),
  }));
}

export async function getTeamsView(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  activityId: string,
): Promise<TeamsView> {
  requireRead(runtimeActor(deps));
  const activity = await getActivitySummary(db, activityId);
  if (activity === null) throw new DomainError("NOT_FOUND", "The activity was not found.");
  const { artifact } = await currentTeams(db, activity);
  const teams = await listTeams(db, activityId);
  const members = await listActiveMembers(db, teams.map((team) => team.id));
  const approved = await approvedParticipants(db, activityId);
  const activeTeams = teams.filter((team) => team.status !== "withdrawn");
  return {
    activityId,
    definitionVersion: activity.activeDefinitionVersion,
    definition: artifact,
    rosterFingerprint: rosterFingerprint(teams, members),
    rosterFrozen: activeTeams.length > 0 && activeTeams.every((team) => team.status === "frozen"),
    teams: teamViews(teams, members, approved.labels),
    participants: [...approved.ids]
      .sort()
      .map((participantId) => ({
        participantId,
        name: approved.labels.get(participantId) ?? participantId,
      })),
  };
}

export interface CreateTeamInput {
  readonly commandId: string;
  readonly activityId: string;
  readonly teamKey: string;
  readonly name: string;
}

export async function createTeam(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: CreateTeamInput,
): Promise<CommandOutcome<StoredTeam>> {
  const actor = runtimeActor(deps);
  const teamKey = normalizeKey(input.teamKey);
  const name = normalizeName(input.name);
  return executeCommand(db, {
    commandId: input.commandId,
    activityId: input.activityId,
    capability: "teams",
    commandType: "teams.team.create",
    actor,
    payload: { teamKey, name },
  }, async (trx) => {
    requirePermission(actor, "teams.manage");
    const activity = await getActivityForUpdate(trx, input.activityId);
    if (activity === null) throw new DomainError("NOT_FOUND", "The activity was not found.");
    requireActive(activity);
    const { artifact } = await currentTeams(trx, activity);
    if (artifact.source === "grouping") {
      throw new DomainError("TEAM_SOURCE_MISMATCH", "This activity imports teams from a frozen grouping stage.");
    }
    const teams = await listTeamsForUpdate(trx, activity.id);
    if (teams.some((team) => team.status === "frozen")) {
      throw new DomainError("TEAM_ROSTER_FROZEN", "The team roster is frozen; correct the roster instead.");
    }
    if (teams.some((team) => team.teamKey === teamKey)) {
      throw new DomainError("TEAM_EXISTS", "The team key is already used in this activity.");
    }
    if (teams.some((team) => team.name === name)) {
      throw new DomainError("TEAM_EXISTS", "The team name is already used in this activity.");
    }
    const id = idFromCommand("team", input.commandId);
    await insertTeam(trx, {
      id,
      activityId: activity.id,
      teamKey,
      name,
      source: "manual",
      createdBy: actor.actorId,
      now: deps.now(),
    });
    const saved = await getTeamForUpdate(trx, id);
    if (saved === null) throw new DomainError("NOT_FOUND", "The team was not created.");
    await appendEngineEvent(trx, deps, {
      type: "TeamCreated",
      activityId: activity.id,
      aggregateType: "team",
      aggregateId: id,
      revision: saved.revision,
      capability: "teams",
      payload: { team: saved },
    });
    return { body: saved, status: 201 };
  });
}

export interface UpdateTeamInput {
  readonly commandId: string;
  readonly activityId: string;
  readonly teamId: string;
  readonly name: string;
  readonly expectedRevision: number;
}

export async function updateTeam(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: UpdateTeamInput,
): Promise<CommandOutcome<StoredTeam>> {
  const actor = runtimeActor(deps);
  const name = normalizeName(input.name);
  return executeCommand(db, {
    commandId: input.commandId,
    activityId: input.activityId,
    capability: "teams",
    commandType: "teams.team.update",
    actor,
    payload: { teamId: input.teamId, name, expectedRevision: input.expectedRevision },
  }, async (trx) => {
    requirePermission(actor, "teams.manage");
    const activity = await getActivityForUpdate(trx, input.activityId);
    if (activity === null) throw new DomainError("NOT_FOUND", "The activity was not found.");
    requireActive(activity);
    await currentTeams(trx, activity);
    const team = await getTeamForUpdate(trx, input.teamId);
    if (team === null || team.activityId !== activity.id) throw new DomainError("NOT_FOUND", "The team was not found.");
    if (team.status === "withdrawn") throw new DomainError("TEAM_WITHDRAWN", "A withdrawn team is read-only.");
    if (team.status !== "draft") throw new DomainError("TEAM_ROSTER_FROZEN", "Freeze the roster through a correction instead.");
    if (team.revision !== input.expectedRevision) throw new DomainError("STALE_REVISION", "The team changed since it was read.");
    const teams = await listTeamsForUpdate(trx, activity.id);
    if (teams.some((item) => item.id !== team.id && item.name === name)) {
      throw new DomainError("TEAM_EXISTS", "The team name is already used in this activity.");
    }
    const updated = await updateTeamName(trx, team.id, input.expectedRevision, name, deps.now());
    if (!updated) throw new DomainError("STALE_REVISION", "The team changed since it was read.");
    const saved = await getTeamForUpdate(trx, team.id);
    if (saved === null) throw new DomainError("NOT_FOUND", "The team was not found.");
    await appendEngineEvent(trx, deps, {
      type: "TeamUpdated",
      activityId: activity.id,
      aggregateType: "team",
      aggregateId: team.id,
      revision: saved.revision,
      capability: "teams",
      payload: { team: saved },
    });
    return { body: saved };
  });
}

export interface AddTeamMemberInput {
  readonly commandId: string;
  readonly activityId: string;
  readonly teamId: string;
  readonly participantId: string;
  readonly role?: string;
  readonly expectedRevision: number;
}

export async function addTeamMember(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: AddTeamMemberInput,
): Promise<CommandOutcome<StoredTeam>> {
  const actor = runtimeActor(deps);
  const role = normalizeRole(input.role ?? "member");
  const participantId = input.participantId.trim();
  if (participantId === "") throw new DomainError("INVALID_INPUT", "A participant id is required.");
  return executeCommand(db, {
    commandId: input.commandId,
    activityId: input.activityId,
    capability: "teams",
    commandType: "teams.team.member.add",
    actor,
    payload: {
      teamId: input.teamId,
      participantId,
      role,
      expectedRevision: input.expectedRevision,
    },
  }, async (trx) => {
    requirePermission(actor, "teams.manage");
    const activity = await getActivityForUpdate(trx, input.activityId);
    if (activity === null) throw new DomainError("NOT_FOUND", "The activity was not found.");
    requireActive(activity);
    const { artifact } = await currentTeams(trx, activity);
    const team = await getTeamForUpdate(trx, input.teamId);
    if (team === null || team.activityId !== activity.id) throw new DomainError("NOT_FOUND", "The team was not found.");
    if (team.status === "withdrawn") throw new DomainError("TEAM_WITHDRAWN", "A withdrawn team is read-only.");
    if (team.status !== "draft") throw new DomainError("TEAM_ROSTER_FROZEN", "The team roster is frozen; correct the roster instead.");
    if (team.revision !== input.expectedRevision) throw new DomainError("STALE_REVISION", "The team changed since it was read.");
    const approved = await approvedParticipants(trx, activity.id);
    requireApproved(approved.ids, participantId);
    const existing = await findActiveMembership(trx, activity.id, participantId);
    if (existing !== null) {
      throw new DomainError("TEAM_MEMBER_EXISTS", "The participant already belongs to an active team.");
    }
    const members = await listActiveMembers(trx, [team.id]);
    if (members.length >= artifact.maxSize) {
      throw new DomainError("TEAM_SIZE_INVALID", `Team ${team.name} already has ${artifact.maxSize} members.`);
    }
    if (role === "captain" && members.some((member) => member.role === "captain")) {
      throw new DomainError("TEAM_CAPTAIN_REQUIRED", `Team ${team.name} already has a captain.`);
    }
    await insertTeamMember(trx, {
      id: idFromCommand("team-member", input.commandId),
      activityId: activity.id,
      teamId: team.id,
      participantId,
      role,
      now: deps.now(),
    });
    const bumped = await bumpTeamRevision(trx, team.id, input.expectedRevision, deps.now());
    if (!bumped) throw new DomainError("STALE_REVISION", "The team changed since it was read.");
    const saved = await getTeamForUpdate(trx, team.id);
    if (saved === null) throw new DomainError("NOT_FOUND", "The team was not found.");
    await appendEngineEvent(trx, deps, {
      type: "TeamMemberAdded",
      activityId: activity.id,
      aggregateType: "team",
      aggregateId: team.id,
      revision: saved.revision,
      capability: "teams",
      payload: { teamId: team.id, participantId, role },
    });
    return { body: saved };
  });
}

export interface RemoveTeamMemberInput {
  readonly commandId: string;
  readonly activityId: string;
  readonly teamId: string;
  readonly participantId: string;
  readonly expectedRevision: number;
}

export async function removeTeamMemberCommand(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: RemoveTeamMemberInput,
): Promise<CommandOutcome<StoredTeam>> {
  const actor = runtimeActor(deps);
  return executeCommand(db, {
    commandId: input.commandId,
    activityId: input.activityId,
    capability: "teams",
    commandType: "teams.team.member.remove",
    actor,
    payload: {
      teamId: input.teamId,
      participantId: input.participantId,
      expectedRevision: input.expectedRevision,
    },
  }, async (trx) => {
    requirePermission(actor, "teams.manage");
    const activity = await getActivityForUpdate(trx, input.activityId);
    if (activity === null) throw new DomainError("NOT_FOUND", "The activity was not found.");
    requireActive(activity);
    await currentTeams(trx, activity);
    const team = await getTeamForUpdate(trx, input.teamId);
    if (team === null || team.activityId !== activity.id) throw new DomainError("NOT_FOUND", "The team was not found.");
    if (team.status === "withdrawn") throw new DomainError("TEAM_WITHDRAWN", "A withdrawn team is read-only.");
    if (team.status !== "draft") throw new DomainError("TEAM_ROSTER_FROZEN", "The team roster is frozen; correct the roster instead.");
    if (team.revision !== input.expectedRevision) throw new DomainError("STALE_REVISION", "The team changed since it was read.");
    const removed = await removeTeamMember(trx, team.id, input.participantId, deps.now());
    if (!removed) throw new DomainError("TEAM_MEMBER_NOT_FOUND", "The participant is not an active member of this team.");
    const bumped = await bumpTeamRevision(trx, team.id, input.expectedRevision, deps.now());
    if (!bumped) throw new DomainError("STALE_REVISION", "The team changed since it was read.");
    const saved = await getTeamForUpdate(trx, team.id);
    if (saved === null) throw new DomainError("NOT_FOUND", "The team was not found.");
    await appendEngineEvent(trx, deps, {
      type: "TeamMemberRemoved",
      activityId: activity.id,
      aggregateType: "team",
      aggregateId: team.id,
      revision: saved.revision,
      capability: "teams",
      payload: { teamId: team.id, participantId: input.participantId },
    });
    return { body: saved };
  });
}

export interface WithdrawTeamInput {
  readonly commandId: string;
  readonly activityId: string;
  readonly teamId: string;
  readonly expectedRevision: number;
  readonly reason: string;
}

export async function withdrawTeamCommand(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: WithdrawTeamInput,
): Promise<CommandOutcome<StoredTeam>> {
  const actor = runtimeActor(deps);
  const reason = normalizeReason(input.reason);
  return executeCommand(db, {
    commandId: input.commandId,
    activityId: input.activityId,
    capability: "teams",
    commandType: "teams.team.withdraw",
    actor,
    payload: { teamId: input.teamId, expectedRevision: input.expectedRevision, reason },
  }, async (trx) => {
    requirePermission(actor, "teams.manage");
    const activity = await getActivityForUpdate(trx, input.activityId);
    if (activity === null) throw new DomainError("NOT_FOUND", "The activity was not found.");
    requireActive(activity);
    await currentTeams(trx, activity);
    const team = await getTeamForUpdate(trx, input.teamId);
    if (team === null || team.activityId !== activity.id) throw new DomainError("NOT_FOUND", "The team was not found.");
    if (team.status === "withdrawn") throw new DomainError("TEAM_WITHDRAWN", "The team is already withdrawn.");
    if (team.revision !== input.expectedRevision) throw new DomainError("STALE_REVISION", "The team changed since it was read.");
    const withdrawn = await withdrawTeam(trx, team.id, input.expectedRevision, deps.now(), reason);
    if (!withdrawn) throw new DomainError("STALE_REVISION", "The team changed since it was read.");
    await closeTeamMembers(trx, team.id, deps.now());
    const saved = await getTeamForUpdate(trx, team.id);
    if (saved === null) throw new DomainError("NOT_FOUND", "The team was not found.");
    await appendEngineEvent(trx, deps, {
      type: "TeamWithdrawn",
      activityId: activity.id,
      aggregateType: "team",
      aggregateId: team.id,
      revision: saved.revision,
      capability: "teams",
      payload: { teamId: team.id, reason },
    });
    return { body: saved };
  });
}

export interface FreezeRosterInput {
  readonly commandId: string;
  readonly activityId: string;
}

export interface RosterSummary {
  readonly rosterFingerprint: string;
  readonly frozenCount: number;
}

export async function freezeTeamRoster(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: FreezeRosterInput,
): Promise<CommandOutcome<RosterSummary>> {
  const actor = runtimeActor(deps);
  return executeCommand(db, {
    commandId: input.commandId,
    activityId: input.activityId,
    capability: "teams",
    commandType: "teams.roster.freeze",
    actor,
    payload: { activityId: input.activityId },
  }, async (trx) => {
    requirePermission(actor, "teams.manage");
    const activity = await getActivityForUpdate(trx, input.activityId);
    if (activity === null) throw new DomainError("NOT_FOUND", "The activity was not found.");
    requireActive(activity);
    const { artifact } = await currentTeams(trx, activity);
    const teams = await listTeamsForUpdate(trx, activity.id);
    const active = teams.filter((team) => team.status !== "withdrawn");
    if (active.length === 0) throw new DomainError("INVALID_TRANSITION", "There are no teams to freeze.");
    if (active.some((team) => team.status === "frozen")) {
      throw new DomainError("TEAM_ROSTER_FROZEN", "The team roster is already frozen.");
    }
    const members = await listActiveMembers(trx, active.map((team) => team.id));
    const approved = await approvedParticipants(trx, activity.id);
    const seen = new Set<string>();
    for (const team of active) {
      const teamMembers = membersFor(team.id, members);
      validateTeamSize(artifact, teamMembers.length, team.name);
      validateCaptains(artifact, teamMembers, team.name);
      for (const member of teamMembers) {
        requireApproved(approved.ids, member.participantId);
        if (seen.has(member.participantId)) {
          throw new DomainError("TEAM_MEMBER_EXISTS", "A participant cannot belong to two teams.");
        }
        seen.add(member.participantId);
      }
    }
    for (const team of active) {
      const frozen = await freezeTeam(trx, team.id, team.revision, team.name, deps.now());
      if (!frozen) throw new DomainError("STALE_REVISION", "The team changed while the roster was freezing.");
    }
    const saved = await listTeams(trx, activity.id);
    const fingerprint = rosterFingerprint(saved, members);
    await appendEngineEvent(trx, deps, {
      type: "TeamRosterFrozen",
      activityId: activity.id,
      aggregateType: "team_roster",
      aggregateId: activity.id,
      revision: active.length,
      capability: "teams",
      payload: { rosterFingerprint: fingerprint, teamIds: active.map((team) => team.id) },
    });
    return { body: { rosterFingerprint: fingerprint, frozenCount: active.length }, status: 201 };
  });
}

export interface RosterSpecTeam {
  readonly teamKey: string;
  readonly name: string;
  readonly members: readonly { readonly participantId: string; readonly role?: string }[];
}

export interface CorrectRosterInput {
  readonly commandId: string;
  readonly activityId: string;
  readonly expectedRosterFingerprint: string;
  readonly reason: string;
  readonly teams: readonly RosterSpecTeam[];
}

function normalizeRosterSpec(
  artifact: CompiledTeamsArtifact,
  approved: ReadonlySet<string>,
  specs: readonly RosterSpecTeam[],
): readonly {
  readonly teamKey: string;
  readonly name: string;
  readonly members: readonly { readonly participantId: string; readonly role: TeamMemberRole }[];
}[] {
  if (specs.length === 0) {
    throw new DomainError("INVALID_INPUT", "A corrected roster needs at least one team.");
  }
  const keys = new Set<string>();
  const names = new Set<string>();
  const participants = new Set<string>();
  return specs.map((spec) => {
    const teamKey = normalizeKey(spec.teamKey);
    const name = normalizeName(spec.name);
    if (keys.has(teamKey)) throw new DomainError("TEAM_EXISTS", `Duplicate team key: ${teamKey}.`);
    if (names.has(name)) throw new DomainError("TEAM_EXISTS", `Duplicate team name: ${name}.`);
    keys.add(teamKey);
    names.add(name);
    const members = spec.members.map((member) => ({
      participantId: member.participantId.trim(),
      role: normalizeRole(member.role ?? "member"),
    }));
    validateTeamSize(artifact, members.length, name);
    validateCaptains(artifact, members, name);
    for (const member of members) {
      requireApproved(approved, member.participantId);
      if (participants.has(member.participantId)) {
        throw new DomainError("TEAM_MEMBER_EXISTS", "A participant cannot belong to two teams.");
      }
      participants.add(member.participantId);
    }
    return { teamKey, name, members };
  });
}

export async function correctTeamRoster(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: CorrectRosterInput,
): Promise<CommandOutcome<RosterSummary>> {
  const actor = runtimeActor(deps);
  const reason = normalizeReason(input.reason);
  return executeCommand(db, {
    commandId: input.commandId,
    activityId: input.activityId,
    capability: "teams",
    commandType: "teams.roster.correct",
    actor,
    payload: {
      expectedRosterFingerprint: input.expectedRosterFingerprint,
      reason,
      teams: input.teams,
    },
  }, async (trx) => {
    requirePermission(actor, "teams.roster.correct");
    const activity = await getActivityForUpdate(trx, input.activityId);
    if (activity === null) throw new DomainError("NOT_FOUND", "The activity was not found.");
    requireActive(activity);
    const { artifact } = await currentTeams(trx, activity);
    const teams = await listTeamsForUpdate(trx, activity.id);
    const currentMembers = await listActiveMembers(trx, teams.map((team) => team.id));
    const currentFingerprint = rosterFingerprint(teams, currentMembers);
    if (currentFingerprint !== input.expectedRosterFingerprint) {
      throw new DomainError("STALE_REVISION", "The team roster changed since it was read.");
    }
    const active = teams.filter((team) => team.status !== "withdrawn");
    if (active.length === 0 || active.some((team) => team.status !== "frozen")) {
      throw new DomainError("TEAM_ROSTER_NOT_FROZEN", "Only a frozen roster can be corrected.");
    }
    const approved = await approvedParticipants(trx, activity.id);
    const spec = normalizeRosterSpec(artifact, approved.ids, input.teams);
    const byKey = new Map(teams.map((team) => [team.teamKey, team]));
    const kept = new Set<string>();
    // Release every active membership first: a correction may move a member from
    // one team to another, and the partial unique index is not deferrable.
    for (const team of active) {
      await closeTeamMembers(trx, team.id, deps.now());
    }
    for (const item of spec) {
      const existing = byKey.get(item.teamKey);
      if (existing?.status === "withdrawn") {
        throw new DomainError("TEAM_WITHDRAWN", "A withdrawn team key cannot be reused.");
      }
      let teamId: string;
      if (existing === undefined) {
        teamId = idFromCommand("team", `${input.commandId}:${item.teamKey}`);
        await insertTeam(trx, {
          id: teamId,
          activityId: activity.id,
          teamKey: item.teamKey,
          name: item.name,
          source: "manual",
          createdBy: actor.actorId,
          now: deps.now(),
        });
        const frozen = await freezeTeam(trx, teamId, 0, item.name, deps.now());
        if (!frozen) throw new DomainError("STALE_REVISION", "A corrected team could not be frozen.");
      } else {
        const corrected = await correctTeam(trx, existing.id, existing.revision, item.name, deps.now());
        if (!corrected) throw new DomainError("STALE_REVISION", "The team changed while the roster was corrected.");
        teamId = existing.id;
      }
      kept.add(item.teamKey);
      for (const member of item.members) {
        await insertTeamMember(trx, {
          id: idFromCommand("team-member", `${input.commandId}:${item.teamKey}:${member.participantId}`),
          activityId: activity.id,
          teamId,
          participantId: member.participantId,
          role: member.role,
          now: deps.now(),
        });
      }
    }
    for (const team of active) {
      if (kept.has(team.teamKey)) continue;
      const withdrawn = await withdrawTeam(trx, team.id, team.revision, deps.now(), reason);
      if (!withdrawn) throw new DomainError("STALE_REVISION", "The team changed while the roster was corrected.");
    }
    const savedTeams = await listTeams(trx, activity.id);
    const savedMembers = await listActiveMembers(trx, savedTeams.map((team) => team.id));
    const fingerprint = rosterFingerprint(savedTeams, savedMembers);
    await appendEngineEvent(trx, deps, {
      type: "TeamRosterCorrected",
      activityId: activity.id,
      aggregateType: "team_roster",
      aggregateId: activity.id,
      revision: savedTeams.length,
      capability: "teams",
      payload: { rosterFingerprint: fingerprint, reason, teamKeys: spec.map((item) => item.teamKey) },
    });
    return {
      body: {
        rosterFingerprint: fingerprint,
        frozenCount: savedTeams.filter((team) => team.status === "frozen").length,
      },
      status: 201,
    };
  });
}

export interface ImportTeamsInput {
  readonly commandId: string;
  readonly activityId: string;
  readonly stageKey: string;
}

export async function importTeamsFromGrouping(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: ImportTeamsInput,
): Promise<CommandOutcome<RosterSummary>> {
  const actor = runtimeActor(deps);
  return executeCommand(db, {
    commandId: input.commandId,
    activityId: input.activityId,
    capability: "teams",
    commandType: "teams.roster.import_grouping",
    actor,
    payload: { stageKey: input.stageKey },
  }, async (trx) => {
    requirePermission(actor, "teams.manage");
    const activity = await getActivityForUpdate(trx, input.activityId);
    if (activity === null) throw new DomainError("NOT_FOUND", "The activity was not found.");
    requireActive(activity);
    const { artifact } = await currentTeams(trx, activity);
    if (artifact.source !== "grouping") {
      throw new DomainError("TEAM_SOURCE_MISMATCH", "This activity builds teams manually.");
    }
    const teams = await listTeamsForUpdate(trx, activity.id);
    if (teams.some((team) => team.status !== "withdrawn")) {
      throw new DomainError("TEAM_IMPORT_CONFLICT", "Import needs an empty team roster.");
    }
    const stage = await getGroupingStageByKey(trx, activity.id, input.stageKey);
    if (stage === null) throw new DomainError("NOT_FOUND", "The grouping stage was not found.");
    if (stage.status !== "frozen") {
      throw new DomainError("GROUPING_STAGE_NOT_FROZEN", "Only a frozen grouping stage can be imported.");
    }
    const groups = (await listGroupingGroups(trx, [stage.id]))
      .filter((group) => group.isActive)
      .sort((left, right) => left.groupOrder - right.groupOrder);
    if (groups.length === 0) throw new DomainError("GROUPING_INCOMPLETE", "The grouping stage has no active groups.");
    const existingKeys = new Set(teams.map((team) => team.teamKey));
    const existingNames = new Set(teams.map((team) => team.name));
    for (const group of groups) {
      if (existingKeys.has(`group-${group.groupOrder}`) || existingNames.has(group.name)) {
        throw new DomainError("TEAM_IMPORT_CONFLICT", "The grouping stage collides with an existing team key or name.");
      }
    }
    const memberships = await listCurrentGroupingMemberships(trx, stage.id);
    const approved = await approvedParticipants(trx, activity.id);
    const seen = new Set<string>();
    for (const group of groups) {
      const members = memberships
        .filter((membership) => membership.groupId === group.id)
        .map((membership) => membership.participantId)
        .sort();
      if (members.length === 0) {
        throw new DomainError("GROUPING_INCOMPLETE", `Group ${group.name} has no members.`);
      }
      for (const participantId of members) {
        requireApproved(approved.ids, participantId);
        if (seen.has(participantId)) {
          throw new DomainError("TEAM_MEMBER_EXISTS", "A participant appears in more than one group.");
        }
        seen.add(participantId);
      }
    }
    for (const group of groups) {
      const teamId = idFromCommand("team", `${input.commandId}:${group.id}`);
      const teamKey = `group-${group.groupOrder}`;
      await insertTeam(trx, {
        id: teamId,
        activityId: activity.id,
        teamKey,
        name: group.name,
        source: "grouping",
        sourceGroupingStageId: stage.id,
        sourceRevision: stage.revision,
        createdBy: actor.actorId,
        now: deps.now(),
      });
      const members = memberships
        .filter((membership) => membership.groupId === group.id)
        .map((membership) => membership.participantId)
        .sort();
      for (const [index, participantId] of members.entries()) {
        await insertTeamMember(trx, {
          id: idFromCommand("team-member", `${input.commandId}:${group.id}:${participantId}`),
          activityId: activity.id,
          teamId,
          participantId,
          role: artifact.requireCaptain && index === 0 ? "captain" : "member",
          now: deps.now(),
        });
      }
    }
    const savedTeams = await listTeams(trx, activity.id);
    const savedMembers = await listActiveMembers(trx, savedTeams.map((team) => team.id));
    const fingerprint = rosterFingerprint(savedTeams, savedMembers);
    await appendEngineEvent(trx, deps, {
      type: "TeamRosterImportedFromGrouping",
      activityId: activity.id,
      aggregateType: "team_roster",
      aggregateId: activity.id,
      revision: savedTeams.length,
      capability: "teams",
      payload: { stageId: stage.id, stageRevision: stage.revision, rosterFingerprint: fingerprint },
    });
    return { body: { rosterFingerprint: fingerprint, frozenCount: 0 }, status: 201 };
  });
}
