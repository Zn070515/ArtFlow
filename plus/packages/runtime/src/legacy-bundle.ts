import { DomainError } from "@artflow-plus/domain";

/** Versioned JSON contract produced by the v1 `export_plus_bundle` command. */

export interface LegacyBundleQuestion {
  readonly key: string;
  readonly label: string;
  readonly type: string;
  readonly required: boolean;
}

export interface LegacyRubricCriterion {
  readonly key: string;
  readonly weight: number;
  readonly maximum: number;
  readonly minimum?: number;
}

export interface LegacyRegistrationBundle {
  readonly legacyId: number;
  readonly participantKey: string;
  readonly status: string;
  readonly answers: Readonly<Record<string, string>>;
  readonly reviewNote: string;
  readonly reviewedBy: string | null;
  readonly createdAt: string;
  readonly liveStatus: string;
}

export interface LegacyMaterialBundle {
  readonly legacyId: number;
  readonly registrationLegacyId: number;
  readonly questionKey: string;
  readonly originalName: string;
  readonly contentType: string;
  readonly byteLength: number;
  /** Relative v1 media path, when the exporter could resolve it. */
  readonly storagePath?: string | null;
  readonly status: string;
  readonly reviewNote: string;
  readonly createdAt: string;
}

export interface LegacyMaterialCheckBundle {
  readonly legacyId: number;
  readonly registrationLegacyId: number;
  readonly questionKey: string;
  readonly itemName: string;
  readonly filePurpose: string;
  readonly acceptedFilePurposes: readonly string[];
  readonly status: "missing" | "uploaded" | "approved" | "needs_supplement";
  readonly required: boolean;
  readonly reviewNote: string;
  readonly sortOrder: number;
}

export interface LegacyRoundBundle {
  readonly legacyId: number;
  readonly key: string;
  readonly sequence: number;
  readonly judgeCount: number;
  readonly minimumJudges: number;
  readonly completion: "full_matrix" | "minimum_valid";
  readonly scoringMethod: "average" | "drop_high_low";
  readonly advanceCount: number;
  readonly state: "prepared" | "scoring" | "locked";
}

export interface LegacyPanelBundle {
  readonly legacyId: number;
  readonly roundLegacyId: number;
  readonly members: readonly { readonly judgeId: string; readonly seatKey: string }[];
}

export interface LegacyPerformanceBundle {
  readonly legacyId: number;
  readonly roundLegacyId: number;
  readonly contestantKey: string;
  readonly sequence: number;
  readonly state: "not_opened" | "open" | "locked";
}

export interface LegacyScoreBundle {
  readonly legacyId: number;
  readonly roundLegacyId: number;
  readonly contestantKey: string;
  readonly judgeId: string;
  readonly panelLegacyId: number | null;
  readonly total: string;
  readonly criteria: Readonly<Record<string, number>>;
  readonly source: "direct_judge" | "staff_rapid" | "staff_proxy" | "paper_dr";
  readonly notes: string;
  readonly createdAt: string;
}

export interface LegacyRankingBundle {
  readonly roundLegacyId: number;
  readonly rows: readonly { readonly contestantId: string; readonly total: string; readonly judgeCount: number }[];
  readonly tieGroups: readonly { readonly total: string; readonly contestants: readonly string[] }[];
  readonly inputFingerprint: string;
  readonly recordedAt: string;
}

export interface LegacyVoteSessionBundle {
  readonly legacyId: number;
  readonly name: string;
  readonly purpose: "popularity" | "score_component";
  readonly selectionType: "single" | "multi";
  readonly maxSelections: number;
  readonly identityPolicy: "ticket" | "browser" | "anonymous";
  readonly scoringRule: Readonly<Record<string, unknown>>;
  readonly status: "open" | "closed";
  readonly openedAt: string | null;
  readonly closedAt: string | null;
  readonly options: readonly { readonly legacyId: number; readonly candidateKey: string }[];
}

export interface LegacyBallotBundle {
  readonly legacyId: number;
  readonly sessionLegacyId: number;
  readonly optionLegacyIds: readonly number[];
  readonly submittedAt: string;
}

export interface LegacyReleaseBundle {
  readonly stageKey: string;
  readonly status: "active" | "revoked" | "superseded";
  readonly snapshot: Readonly<Record<string, unknown>>;
  readonly legacySnapshot?: unknown;
  readonly resultVersion: number;
  readonly postVersion: number;
  readonly note: string;
  readonly releasedAt: string;
}

export interface LegacyStageResultBundle {
  readonly stageKey: string;
  readonly status: "confirmed";
  readonly decisions: readonly Readonly<Record<string, unknown>>[];
  readonly awards: readonly Readonly<Record<string, unknown>>[];
  readonly confirmedAt: string;
}

export interface LegacyCounts {
  readonly registrations: number;
  readonly approvedRegistrations: number;
  readonly materials: number;
  readonly materialChecks?: number;
  readonly rounds: number;
  readonly scores: number;
  readonly ballots: number;
  readonly releases: number;
}

export interface LegacyExcluded {
  readonly testRegistrations: number;
  readonly testScores: number;
  readonly testBallots: number;
  readonly testMaterials: number;
}

export interface LegacyBundle {
  readonly format: "artflow-plus-legacy-bundle";
  readonly version: 1;
  readonly exportedAt: string;
  readonly source: {
    readonly publicCode: string;
    readonly activityId: number;
    readonly v1Version: string;
  };
  readonly activity: {
    readonly publicCode: string;
    readonly title: string;
    readonly subtitle: string;
    readonly activityType: string;
    readonly phase: string;
    readonly createdAt: string;
  };
  readonly questionnaire: {
    readonly version: string;
    readonly questions: readonly LegacyBundleQuestion[];
  };
  readonly ruleset: { readonly present: boolean; readonly raw: unknown };
  readonly rubric: {
    readonly criteria: readonly LegacyRubricCriterion[];
    readonly tiePolicy: "review";
  };
  readonly rounds: readonly LegacyRoundBundle[];
  readonly registrations: readonly LegacyRegistrationBundle[];
  readonly roster: {
    readonly status: "final" | "unknown";
    readonly approvedCount: number;
    readonly finalizedAt: string | null;
  };
  readonly materials: readonly LegacyMaterialBundle[];
  /** Staff-owned checks, including slots with no SubmissionFile. */
  readonly materialChecks?: readonly LegacyMaterialCheckBundle[];
  readonly competition: {
    readonly panels: readonly LegacyPanelBundle[];
    readonly seats: readonly {
      readonly legacyId: number;
      readonly panelLegacyId: number;
      readonly judgeId: string;
      readonly seatKey: string;
    }[];
    readonly performances: readonly LegacyPerformanceBundle[];
    readonly scores: readonly LegacyScoreBundle[];
    readonly rankings: readonly LegacyRankingBundle[];
  };
  readonly voting: {
    readonly sessions: readonly LegacyVoteSessionBundle[];
    readonly ballots: readonly LegacyBallotBundle[];
  };
  readonly results: {
    readonly stageResults: readonly LegacyStageResultBundle[];
    readonly releases: readonly LegacyReleaseBundle[];
  };
  readonly grouping?: readonly {
    readonly legacyId: number;
    readonly stageKey: string;
    readonly name: string;
    readonly status: "draft" | "confirmed" | "frozen" | "cancelled";
    readonly rosterSource: "all_approved" | "round_advanced";
    readonly sourceRoundLegacyId?: number | null;
    readonly materialWindow: "closed" | "open" | "supplement_only";
    readonly groups: readonly {
      readonly legacyId: number;
      readonly name: string;
      readonly groupOrder: number;
      readonly participantKeys: readonly string[];
    }[];
  }[];
  readonly counts: LegacyCounts;
  readonly excluded: LegacyExcluded;
  readonly unsupported: readonly { readonly kind: string; readonly legacyId?: number; readonly reason: string }[];
}

function invalid(message: string): never {
  throw new DomainError("LEGACY_BUNDLE_INVALID", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireArray(value: Record<string, unknown>, key: string): unknown[] {
  const item = value[key];
  if (!Array.isArray(item)) invalid(`The bundle is missing the ${key} array.`);
  return item;
}

/** Structural validation plus the reference integrity everything below relies on. */
export function parseLegacyBundle(value: unknown): LegacyBundle {
  if (!isRecord(value)) invalid("The bundle must be a JSON object.");
  if (value.format !== "artflow-plus-legacy-bundle") invalid("Unsupported bundle format.");
  if (value.version !== 1) invalid("Unsupported bundle version.");
  if (!isRecord(value.activity) || typeof value.activity.publicCode !== "string" || value.activity.publicCode === "") {
    invalid("The bundle is missing activity.publicCode.");
  }
  if (!isRecord(value.source) || typeof value.source.publicCode !== "string") {
    invalid("The bundle is missing source.publicCode.");
  }
  if (!isRecord(value.questionnaire) || typeof value.questionnaire.version !== "string") {
    invalid("The bundle is missing questionnaire.version.");
  }
  if (!isRecord(value.rubric) || !Array.isArray(value.rubric.criteria)) {
    invalid("The bundle is missing rubric.criteria.");
  }
  if (!isRecord(value.roster) || !isRecord(value.counts) || !isRecord(value.excluded)) {
    invalid("The bundle is missing roster/counts/excluded.");
  }
  requireArray(value, "registrations");
  requireArray(value, "materials");
  if (value.materialChecks !== undefined) requireArray(value, "materialChecks");
  requireArray(value, "rounds");
  requireArray(value, "unsupported");
  if (!isRecord(value.competition)) invalid("The bundle is missing competition.");
  for (const key of ["panels", "seats", "performances", "scores", "rankings"]) {
    requireArray(value.competition, key);
  }
  if (!isRecord(value.voting)) invalid("The bundle is missing voting.");
  requireArray(value.voting, "sessions");
  requireArray(value.voting, "ballots");
  if (!isRecord(value.results)) invalid("The bundle is missing results.");
  requireArray(value.results, "stageResults");
  requireArray(value.results, "releases");

  if (value.materialChecks === undefined) value.materialChecks = [];
  const bundle = value as unknown as LegacyBundle;
  const registrationIds = new Set(bundle.registrations.map((row) => row.legacyId));
  for (const check of bundle.materialChecks ?? []) {
    if (!registrationIds.has(check.registrationLegacyId)) {
      invalid(`Material check ${check.legacyId} references an unknown registration.`);
    }
  }
  for (const material of bundle.materials) {
    if (!registrationIds.has(material.registrationLegacyId)) {
      invalid(`Material ${material.legacyId} references an unknown registration.`);
    }
  }
  const roundIds = new Set(bundle.rounds.map((row) => row.legacyId));
  for (const score of bundle.competition.scores) {
    if (!roundIds.has(score.roundLegacyId)) invalid(`Score ${score.legacyId} references an unknown round.`);
  }
  const sessionIds = new Set(bundle.voting.sessions.map((row) => row.legacyId));
  const optionIds = new Set(bundle.voting.sessions.flatMap((row) => row.options.map((option) => option.legacyId)));
  for (const ballot of bundle.voting.ballots) {
    if (!sessionIds.has(ballot.sessionLegacyId)) invalid(`Ballot ${ballot.legacyId} references an unknown session.`);
    for (const optionId of ballot.optionLegacyIds) {
      if (!optionIds.has(optionId)) invalid(`Ballot ${ballot.legacyId} references an unknown option.`);
    }
  }
  return bundle;
}
