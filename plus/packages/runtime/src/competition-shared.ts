import type {
  Database,
  StoredPanelSnapshot,
  StoredRound,
} from "@artflow-plus/db";
import {
  getRelease,
} from "@artflow-plus/db";
import type {
  ActorContext,
  CompiledCompetitionArtifact,
} from "@artflow-plus/domain";
import {
  DomainError,
} from "@artflow-plus/domain";
import type { Kysely } from "kysely";

import { requireRunningCommandSession } from "./command-scope.js";


export interface CompetitionActivity {
  readonly id: string;
  readonly status: string;
  readonly activeDefinitionVersion: number;
  readonly enabledCapabilities: readonly string[];
}

export interface JudgeInput {
  readonly judgeId: string;
  readonly seatKey: string;
}


export function requireActive(activity: CompetitionActivity): void {
  if (activity.status !== "active") {
    throw new DomainError("ACTIVITY_NOT_ACTIVE", "Competition commands require an active activity.");
  }
}

export function requireSetupPermission(actor: ActorContext): void {
  if (!actor.permissions.includes("competition.manage")) {
    throw new DomainError("FORBIDDEN", "The actor cannot manage competition operations.");
  }
}

export function requireRoundPreparePermission(actor: ActorContext): void {
  if (!actor.permissions.includes("competition.manage") && !actor.permissions.includes("competition.round.prepare")) {
    throw new DomainError("FORBIDDEN", "The actor cannot prepare competition rounds.");
  }
}

export function requireCompetitionArtifact(
  activity: CompetitionActivity,
  release: Awaited<ReturnType<typeof getRelease>>,
): CompiledCompetitionArtifact {
  if (!activity.enabledCapabilities.includes("competition")) {
    throw new DomainError("CAPABILITY_NOT_ENABLED", "Competition is not enabled on this activity.");
  }
  const plan = release?.capabilities.competition;
  if (plan === undefined || plan.ok !== true) {
    throw new DomainError("RELEASE_SNAPSHOT_INCOMPLETE", "The release has no competition snapshot.");
  }
  return plan.artifact as CompiledCompetitionArtifact;
}

export function roundConfig(artifact: CompiledCompetitionArtifact, roundKey: string) {
  const config = artifact.rounds.find((round) => round.key === roundKey);
  if (config === undefined && artifact.rounds.length === 0 && roundKey === "round-1") {
    // M4's empty competition package intentionally represented an unconfigured
    // roster-to-result boundary. Keep its historical round-1 rehearsal path
    // valid while configured releases remain strict about declared round keys.
    return {
      key: roundKey,
      judgeCount: 1,
      minimumJudges: 1,
      completion: "minimum_valid" as const,
      advanceCount: 0,
      scoringMethod: "average" as const,
    };
  }
  if (config === undefined) {
    throw new DomainError("ROUND_UNKNOWN", `Round ${roundKey} is not configured by the release.`);
  }
  return config;
}

export async function runningSession(
  trx: Kysely<Database>,
  activity: CompetitionActivity,
  commandType: string,
  scope: string,
) {
  const { release, session } = await requireRunningCommandSession(trx, activity, commandType, scope);
  if (release.executionPolicy.declaredScopes.length > 0 && !release.executionPolicy.declaredScopes.includes(scope)) {
    throw new DomainError("SCOPE_UNDECLARED", `Scope ${scope} is not declared by the release.`);
  }
  return { release, session };
}

export function requireRoundForActivity(round: StoredRound | null, activityId: string): StoredRound {
  if (round === null) throw new DomainError("NOT_FOUND", "The competition round was not found.");
  if (round.activityId !== activityId) throw new DomainError("CROSS_ACTIVITY", "The round belongs to another activity.");
  return round;
}

export function requireActivePanel(panel: StoredPanelSnapshot | null): StoredPanelSnapshot {
  if (panel === null) throw new DomainError("PANEL_NOT_ACTIVE", "The round has no current panel.");
  if (panel.state !== "active" || !panel.current) {
    throw new DomainError("PANEL_NOT_ACTIVE", "The current panel is not active.");
  }
  return panel;
}

export function scoreGateMinimum(round: StoredRound): number {
  return round.completionMode === "full_matrix" ? round.judgeCount : round.minimumJudges;
}

export function requireGateClosed(round: StoredRound, scoreCount: number): void {
  if (scoreCount < scoreGateMinimum(round)) {
    throw new DomainError("SCORE_GATE_OPEN", `The performance has ${scoreCount} valid scores; ${scoreGateMinimum(round)} are required.`);
  }
}
