import { apiFetch } from "./client.js";

export type TeamStatus = "draft" | "frozen" | "withdrawn";
export type TeamMemberRole = "member" | "captain";
export type TeamSource = "manual" | "grouping";

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
  readonly status: TeamStatus;
  readonly source: TeamSource;
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
  readonly definition: {
    readonly schemaVersion: 1;
    readonly minSize: number;
    readonly maxSize: number;
    readonly requireCaptain: boolean;
    readonly source: TeamSource;
  };
  readonly rosterFingerprint: string;
  readonly rosterFrozen: boolean;
  readonly teams: readonly TeamView[];
  readonly participants: readonly TeamParticipantOption[];
}

export interface RosterSummary {
  readonly rosterFingerprint: string;
  readonly frozenCount: number;
}

export interface RosterSpecTeam {
  readonly teamKey: string;
  readonly name: string;
  readonly members: readonly { readonly participantId: string; readonly role?: TeamMemberRole }[];
}

export function fetchTeams(activityId: string): Promise<TeamsView> {
  return apiFetch(`/api/activities/${encodeURIComponent(activityId)}/teams`);
}

export function createTeam(
  activityId: string,
  commandId: string,
  input: { readonly teamKey: string; readonly name: string },
): Promise<TeamView> {
  return apiFetch(`/api/activities/${encodeURIComponent(activityId)}/teams`, {
    method: "POST",
    headers: { "idempotency-key": commandId },
    body: JSON.stringify(input),
  });
}

export function updateTeam(
  activityId: string,
  team: TeamView,
  commandId: string,
  name: string,
): Promise<TeamView> {
  return apiFetch(`/api/activities/${encodeURIComponent(activityId)}/teams/${encodeURIComponent(team.id)}`, {
    method: "PUT",
    headers: { "idempotency-key": commandId },
    body: JSON.stringify({ name, expectedRevision: team.revision }),
  });
}

export function addTeamMember(
  activityId: string,
  team: TeamView,
  commandId: string,
  participantId: string,
  role: TeamMemberRole = "member",
): Promise<TeamView> {
  return apiFetch(
    `/api/activities/${encodeURIComponent(activityId)}/teams/${encodeURIComponent(team.id)}/members`,
    {
      method: "POST",
      headers: { "idempotency-key": commandId },
      body: JSON.stringify({ participantId, role, expectedRevision: team.revision }),
    },
  );
}

export function removeTeamMember(
  activityId: string,
  team: TeamView,
  participantId: string,
  commandId: string,
): Promise<TeamView> {
  return apiFetch(
    `/api/activities/${encodeURIComponent(activityId)}/teams/${encodeURIComponent(team.id)}/members/${encodeURIComponent(participantId)}/remove`,
    {
      method: "POST",
      headers: { "idempotency-key": commandId },
      body: JSON.stringify({ expectedRevision: team.revision }),
    },
  );
}

export function withdrawTeam(
  activityId: string,
  team: TeamView,
  reason: string,
  commandId: string,
): Promise<TeamView> {
  return apiFetch(
    `/api/activities/${encodeURIComponent(activityId)}/teams/${encodeURIComponent(team.id)}/withdraw`,
    {
      method: "POST",
      headers: { "idempotency-key": commandId },
      body: JSON.stringify({ expectedRevision: team.revision, reason }),
    },
  );
}

export function freezeTeamRoster(activityId: string, commandId: string): Promise<RosterSummary> {
  return apiFetch(`/api/activities/${encodeURIComponent(activityId)}/teams/freeze`, {
    method: "POST",
    headers: { "idempotency-key": commandId },
  });
}

export function correctTeamRoster(
  activityId: string,
  commandId: string,
  input: {
    readonly expectedRosterFingerprint: string;
    readonly reason: string;
    readonly teams: readonly RosterSpecTeam[];
  },
): Promise<RosterSummary> {
  return apiFetch(`/api/activities/${encodeURIComponent(activityId)}/teams/correct`, {
    method: "POST",
    headers: { "idempotency-key": commandId },
    body: JSON.stringify(input),
  });
}

export function importTeamsFromGrouping(
  activityId: string,
  stageKey: string,
  commandId: string,
): Promise<RosterSummary> {
  return apiFetch(`/api/activities/${encodeURIComponent(activityId)}/teams/import`, {
    method: "POST",
    headers: { "idempotency-key": commandId },
    body: JSON.stringify({ stageKey }),
  });
}
