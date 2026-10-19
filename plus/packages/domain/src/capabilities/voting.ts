import { capabilityDefinitionHash } from "../compiler.js";
import { fail } from "../errors.js";
import type {
  CapabilityCompileResult,
  CapabilityCompiler,
  CapabilityDefinition,
  CompileIssue,
  CompiledCapabilityPlan,
} from "../model.js";
import { deepFreeze } from "../model.js";
import type { CapabilityRegistration } from "../registry.js";

export type VotingPurpose = "popularity" | "score_component";
export type VotingSelectionType = "single" | "multi";

export interface VotingScoringRule {
  readonly kind: "ballot_share_percent";
  readonly scale: number;
  readonly decimals: number;
}

export interface VotingDefinition {
  readonly schemaVersion: 1;
  readonly purpose: VotingPurpose;
  readonly selectionType: VotingSelectionType;
  readonly maxSelections: number;
  readonly requiresTicket: boolean;
  readonly allowBrowserIdentity: boolean;
  readonly scoringRule: VotingScoringRule;
}

export interface CompiledVotingArtifact extends VotingDefinition {
  readonly version: 1;
}

export function createVotingDefinition(
  input: Omit<VotingDefinition, "schemaVersion">,
): CapabilityDefinition {
  return { schemaVersion: 1, payload: { schemaVersion: 1, ...input } };
}

function issue(code: string, message: string, path: string): CompileIssue {
  return { code, message, path };
}

function asDefinition(payload: unknown): VotingDefinition | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const value = payload as Partial<VotingDefinition>;
  if (value.schemaVersion !== 1) return null;
  return value as VotingDefinition;
}

export function compileVotingDefinition(
  definition: CapabilityDefinition,
): CapabilityCompileResult {
  const payload = asDefinition(definition.payload);
  if (payload === null) {
    return deepFreeze({
      ok: false,
      issues: [issue("PAYLOAD_INVALID", "Not a voting definition.", "payload")],
    });
  }
  const issues: CompileIssue[] = [];
  if (payload.purpose !== "popularity" && payload.purpose !== "score_component") {
    issues.push(issue("PURPOSE_INVALID", "Voting purpose is invalid.", "purpose"));
  }
  if (payload.selectionType !== "single" && payload.selectionType !== "multi") {
    issues.push(issue("SELECTION_TYPE_INVALID", "Voting selection type is invalid.", "selectionType"));
  }
  if (!Number.isInteger(payload.maxSelections) || payload.maxSelections < 1) {
    issues.push(issue("MAX_SELECTIONS_INVALID", "maxSelections must be a positive integer.", "maxSelections"));
  }
  if (payload.selectionType === "single" && payload.maxSelections !== 1) {
    issues.push(issue("MAX_SELECTIONS_INVALID", "Single-select voting must allow exactly one option.", "maxSelections"));
  }
  if (payload.selectionType === "multi" && payload.maxSelections < 2) {
    issues.push(issue("MAX_SELECTIONS_INVALID", "Multi-select voting must allow at least two options.", "maxSelections"));
  }
  if (typeof payload.requiresTicket !== "boolean") {
    issues.push(issue("TICKET_POLICY_INVALID", "requiresTicket must be boolean.", "requiresTicket"));
  }
  if (typeof payload.allowBrowserIdentity !== "boolean") {
    issues.push(issue("BROWSER_IDENTITY_INVALID", "allowBrowserIdentity must be boolean.", "allowBrowserIdentity"));
  }
  if (payload.requiresTicket && payload.allowBrowserIdentity) {
    issues.push(issue("IDENTITY_POLICY_INVALID", "Ticket-backed voting cannot allow browser identity.", "allowBrowserIdentity"));
  }
  const rule = payload.scoringRule;
  if (rule === null || typeof rule !== "object" || rule.kind !== "ballot_share_percent") {
    issues.push(issue("SCORING_RULE_INVALID", "Only ballot_share_percent is supported.", "scoringRule"));
  } else {
    if (!Number.isFinite(rule.scale) || rule.scale <= 0) {
      issues.push(issue("SCORING_SCALE_INVALID", "Scoring scale must be positive.", "scoringRule.scale"));
    }
    if (!Number.isInteger(rule.decimals) || rule.decimals < 0 || rule.decimals > 6) {
      issues.push(issue("SCORING_DECIMALS_INVALID", "Scoring decimals must be between 0 and 6.", "scoringRule.decimals"));
    }
  }
  if (issues.length > 0) return deepFreeze({ ok: false, issues });

  const artifact: CompiledVotingArtifact = {
    version: 1,
    schemaVersion: 1,
    purpose: payload.purpose,
    selectionType: payload.selectionType,
    maxSelections: payload.maxSelections,
    requiresTicket: payload.requiresTicket,
    allowBrowserIdentity: payload.allowBrowserIdentity,
    scoringRule: { ...payload.scoringRule },
  };
  const plan: CompiledCapabilityPlan = {
    ok: true,
    capabilityKey: "voting",
    contentHash: capabilityDefinitionHash(definition),
    artifact: deepFreeze(artifact),
  };
  return deepFreeze(plan);
}

export const votingCompiler: CapabilityCompiler = {
  capabilityKey: "voting",
  compile: compileVotingDefinition,
};

export function createEmptyVotingDefinition(): CapabilityDefinition {
  return createVotingDefinition({
    purpose: "popularity",
    selectionType: "single",
    maxSelections: 1,
    requiresTicket: false,
    allowBrowserIdentity: true,
    scoringRule: { kind: "ballot_share_percent", scale: 100, decimals: 2 },
  });
}

export const votingCapability: CapabilityRegistration = deepFreeze({
  manifest: {
    identity: "voting",
    version: "1",
    dependencies: ["ticketing"],
    conflicts: [],
    definitionSchemaVersion: 1,
    commands: [
      "voting.session.open",
      "voting.ballot.submit",
      "voting.session.close",
      "voting.scores.compute",
    ],
    queries: ["voting.session.read", "voting.live.read"],
    events: [
      "VoteSessionOpened",
      "BallotSubmitted",
      "VoteSessionClosed",
      "VoteScoresComputed",
      "LiveStateUpdated",
    ],
    permissions: ["voting.manage", "voting.ballot.submit"],
    surfaces: ["studio", "ops", "portal", "live"],
    scopes: ["voting"],
  },
  compiler: votingCompiler,
  emptyDefinition: createEmptyVotingDefinition,
});

export interface VoteScoreInput {
  readonly counts: Readonly<Record<string, number>>;
  readonly totalBallots: number;
  readonly rule: VotingScoringRule;
}

/** Converts raw ballot counts to score-component inputs; it never creates judge facts. */
export function computeVoteScores(input: VoteScoreInput): Readonly<Record<string, number>> {
  if (!Number.isInteger(input.totalBallots) || input.totalBallots < 0) {
    fail("INVALID_INPUT", "totalBallots must be a non-negative integer.");
  }
  if (input.rule.kind !== "ballot_share_percent" || !Number.isFinite(input.rule.scale) || input.rule.scale <= 0) {
    fail("INVALID_INPUT", "The voting score rule is invalid.");
  }
  if (!Number.isInteger(input.rule.decimals) || input.rule.decimals < 0 || input.rule.decimals > 6) {
    fail("INVALID_INPUT", "The voting score decimals are invalid.");
  }
  const factor = 10 ** input.rule.decimals;
  const result: Record<string, number> = {};
  for (const optionId of Object.keys(input.counts).sort()) {
    const count = input.counts[optionId];
    if (count === undefined || !Number.isInteger(count) || count < 0) {
      fail("INVALID_INPUT", `Vote count for ${optionId} is invalid.`);
    }
    const value = input.totalBallots === 0 ? 0 : (count / input.totalBallots) * input.rule.scale;
    result[optionId] = Math.round(value * factor) / factor;
  }
  return deepFreeze(result);
}
