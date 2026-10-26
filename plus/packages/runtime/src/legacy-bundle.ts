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
  readonly status: string;
  readonly reviewNote: string;
  readonly createdAt: string;
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
  readonly counts: LegacyCounts;
  readonly excluded: LegacyExcluded;
  readonly unsupported: readonly { readonly kind: string; readonly legacyId?: number; readonly reason: string }[];
}
