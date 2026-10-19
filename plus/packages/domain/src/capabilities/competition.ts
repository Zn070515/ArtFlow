import { capabilityDefinitionHash } from "../compiler.js";
import type {
  CapabilityCompileResult,
  CapabilityCompiler,
  CapabilityDefinition,
  CompileIssue,
  CompiledCapabilityPlan,
} from "../model.js";
import { deepFreeze } from "../model.js";
import type { CapabilityRegistration } from "../registry.js";

/**
 * Competition owns this language. The Activity compiler only sees the opaque
 * `CapabilityDefinition` wrapper and never imports these node types.
 */
export type CompetitionNodeType = "roster" | "round" | "aggregate" | "output";

export interface CompetitionNode {
  readonly key: string;
  readonly type: CompetitionNodeType;
  readonly label?: string;
}

export interface CompetitionEdge {
  readonly from: string;
  readonly to: string;
}

export type CompetitionCompletionMode = "full_matrix" | "minimum_valid";
export type CompetitionTiePolicy = "review";

export interface CompetitionRoundDefinition {
  readonly key: string;
  readonly judgeCount: number;
  readonly minimumJudges: number;
  readonly completion: CompetitionCompletionMode;
  readonly advanceCount?: number;
  readonly scoringMethod?: "average" | "drop_high_low";
}

export interface CompetitionRubricCriterion {
  readonly key: string;
  readonly weight: number;
  readonly maximum: number;
  readonly minimum?: number;
}

export interface CompetitionRubricDefinition {
  readonly criteria: readonly CompetitionRubricCriterion[];
}

export interface CompetitionDefinition {
  readonly schemaVersion: 1;
  readonly nodes: readonly CompetitionNode[];
  readonly edges: readonly CompetitionEdge[];
  readonly rounds?: readonly CompetitionRoundDefinition[];
  readonly rubric?: CompetitionRubricDefinition;
  readonly tiePolicy?: CompetitionTiePolicy;
}

export interface CompiledCompetitionArtifact {
  readonly order: readonly string[];
  readonly nodes: readonly CompetitionNode[];
  readonly edges: readonly CompetitionEdge[];
  readonly rounds: readonly CompetitionRoundDefinition[];
  readonly rubric: CompetitionRubricDefinition;
  readonly tiePolicy: CompetitionTiePolicy;
}

const NODE_TYPES: ReadonlySet<CompetitionNodeType> = new Set([
  "roster",
  "round",
  "aggregate",
  "output",
]);

function byKey(left: CompetitionNode, right: CompetitionNode): number {
  if (left.key < right.key) return -1;
  if (left.key > right.key) return 1;
  return 0;
}

function byEdge(left: CompetitionEdge, right: CompetitionEdge): number {
  const from = left.from < right.from ? -1 : left.from > right.from ? 1 : 0;
  if (from !== 0) return from;
  if (left.to < right.to) return -1;
  if (left.to > right.to) return 1;
  return 0;
}

function issue(code: string, message: string, path: string): CompileIssue {
  return { code, message, path };
}

function asCompetitionDefinition(payload: unknown): CompetitionDefinition | null {
  if (payload === null || typeof payload !== "object") return null;
  const candidate = payload as Partial<CompetitionDefinition>;
  if (candidate.schemaVersion !== 1) return null;
  if (!Array.isArray(candidate.nodes) || !Array.isArray(candidate.edges)) return null;
  return candidate as CompetitionDefinition;
}

export function createCompetitionDefinition(
  nodes: readonly CompetitionNode[],
  edges: readonly CompetitionEdge[],
  options: Pick<CompetitionDefinition, "rounds" | "rubric" | "tiePolicy"> = {},
): CapabilityDefinition {
  const payload: CompetitionDefinition = { schemaVersion: 1, nodes, edges, ...options };
  return { schemaVersion: 1, payload };
}

export function compileCompetitionDefinition(
  definition: CapabilityDefinition,
): CapabilityCompileResult {
  const payload = asCompetitionDefinition(definition.payload);
  if (payload === null) {
    return deepFreeze({
      ok: false,
      issues: [issue("PAYLOAD_INVALID", "Not a competition definition.", "payload")],
    });
  }

  const issues: CompileIssue[] = [];
  if (payload.nodes.length === 0) {
    issues.push(issue("EMPTY_DEFINITION", "A definition needs at least one node.", "nodes"));
  }

  const keys = new Set<string>();
  const incoming = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const node of payload.nodes) {
    if (!node.key.trim()) {
      issues.push(issue("EMPTY_KEY", "A node key cannot be empty.", "nodes"));
      continue;
    }
    if (keys.has(node.key)) {
      issues.push(issue("DUPLICATE_NODE", `Duplicate node key: ${node.key}.`, node.key));
      continue;
    }
    if (!NODE_TYPES.has(node.type)) {
      issues.push(issue("UNKNOWN_NODE_TYPE", `Unknown node type: ${node.type}.`, node.key));
      continue;
    }
    keys.add(node.key);
    incoming.set(node.key, 0);
    outgoing.set(node.key, []);
  }

  const edgeKeys = new Set<string>();
  for (const edge of payload.edges) {
    if (!keys.has(edge.from) || !keys.has(edge.to)) {
      issues.push(
        issue("EDGE_UNKNOWN_NODE", `Edge ${edge.from} -> ${edge.to} names an unknown node.`, "edges"),
      );
      continue;
    }
    const edgeKey = `${edge.from}->${edge.to}`;
    if (edgeKeys.has(edgeKey)) {
      issues.push(issue("DUPLICATE_EDGE", `Duplicate edge: ${edgeKey}.`, edgeKey));
      continue;
    }
    edgeKeys.add(edgeKey);
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
    const next = outgoing.get(edge.from);
    if (next === undefined) {
      issues.push(issue("EDGE_UNKNOWN_NODE", `Edge ${edgeKey} names an unknown node.`, "edges"));
      continue;
    }
    next.push(edge.to);
  }

  let outputCount = 0;
  for (const node of payload.nodes) {
    if (!keys.has(node.key)) continue;
    if (node.type === "output") outputCount += 1;
    if (node.type !== "roster" && (incoming.get(node.key) ?? 0) === 0) {
      issues.push(issue("ORPHAN_NODE", `Node ${node.key} has no incoming edge.`, node.key));
    }
  }
  if (outputCount === 0) {
    issues.push(issue("NO_OUTPUT", "A definition needs at least one output node.", "nodes"));
  }

  const roundNodes = new Set(
    payload.nodes.filter((node) => node.type === "round").map((node) => node.key),
  );
  const configuredRounds = payload.rounds ?? [];
  const roundKeys = new Set<string>();
  for (const round of configuredRounds) {
    if (!round.key.trim()) {
      issues.push(issue("EMPTY_ROUND_KEY", "A round key cannot be empty.", "rounds"));
      continue;
    }
    if (roundKeys.has(round.key)) {
      issues.push(issue("DUPLICATE_ROUND", `Duplicate round key: ${round.key}.`, round.key));
      continue;
    }
    roundKeys.add(round.key);
    if (!roundNodes.has(round.key)) {
      issues.push(issue("ROUND_NODE_REQUIRED", `Round ${round.key} is not declared as a round node.`, round.key));
    }
    if (!Number.isInteger(round.judgeCount) || round.judgeCount < 1) {
      issues.push(issue("JUDGE_COUNT_INVALID", `Round ${round.key} needs a positive judge count.`, round.key));
    }
    if (!Number.isInteger(round.minimumJudges) || round.minimumJudges < 1 || round.minimumJudges > round.judgeCount) {
      issues.push(issue("MINIMUM_JUDGES_INVALID", `Round ${round.key} has an invalid minimum judge count.`, round.key));
    }
    if (round.completion !== "full_matrix" && round.completion !== "minimum_valid") {
      issues.push(issue("COMPLETION_MODE_INVALID", `Round ${round.key} has an invalid completion mode.`, round.key));
    }
    if (round.advanceCount !== undefined && (!Number.isInteger(round.advanceCount) || round.advanceCount < 0)) {
      issues.push(issue("ADVANCE_COUNT_INVALID", `Round ${round.key} has an invalid advancement count.`, round.key));
    }
  }

  const rubric = payload.rubric ?? { criteria: [] };
  if (!Array.isArray(rubric.criteria)) {
    issues.push(issue("RUBRIC_INVALID", "A rubric needs a criteria array.", "rubric.criteria"));
  }
  const criterionKeys = new Set<string>();
  for (const criterion of rubric.criteria ?? []) {
    if (!criterion.key.trim()) {
      issues.push(issue("EMPTY_CRITERION_KEY", "A criterion key cannot be empty.", "rubric.criteria"));
      continue;
    }
    if (criterionKeys.has(criterion.key)) {
      issues.push(issue("DUPLICATE_CRITERION", `Duplicate criterion key: ${criterion.key}.`, criterion.key));
      continue;
    }
    criterionKeys.add(criterion.key);
    if (!Number.isFinite(criterion.weight) || criterion.weight <= 0) {
      issues.push(issue("CRITERION_WEIGHT_INVALID", `Criterion ${criterion.key} needs a positive weight.`, criterion.key));
    }
    if (!Number.isFinite(criterion.maximum) || criterion.maximum <= 0) {
      issues.push(issue("CRITERION_MAXIMUM_INVALID", `Criterion ${criterion.key} needs a positive maximum.`, criterion.key));
    }
    if (criterion.minimum !== undefined && (!Number.isFinite(criterion.minimum) || criterion.minimum < 0 || criterion.minimum > criterion.maximum)) {
      issues.push(issue("CRITERION_MINIMUM_INVALID", `Criterion ${criterion.key} has an invalid minimum.`, criterion.key));
    }
  }
  const tiePolicy = payload.tiePolicy ?? "review";
  if (tiePolicy !== "review") {
    issues.push(issue("TIE_POLICY_INVALID", "Only explicit review tie handling is supported.", "tiePolicy"));
  }

  const queue = [...keys].filter((key) => (incoming.get(key) ?? 0) === 0).sort();
  const order: string[] = [];
  while (queue.length > 0) {
    const key = queue.shift();
    if (key === undefined) break;
    order.push(key);
    for (const next of outgoing.get(key) ?? []) {
      const remaining = (incoming.get(next) ?? 0) - 1;
      incoming.set(next, remaining);
      if (remaining === 0) {
        queue.push(next);
        queue.sort();
      }
    }
  }
  if (order.length !== keys.size) {
    issues.push(issue("CYCLE", "The definition graph contains a cycle.", "edges"));
  }

  if (issues.length > 0) {
    return deepFreeze({ ok: false, issues });
  }

  const artifact: CompiledCompetitionArtifact = {
    order,
    nodes: [...payload.nodes].sort(byKey).map((node) => ({ ...node })),
    edges: [...payload.edges].sort(byEdge).map((edge) => ({ ...edge })),
    rounds: [...configuredRounds].sort((left, right) => left.key.localeCompare(right.key)).map((round) => ({ ...round, advanceCount: round.advanceCount ?? 0, scoringMethod: round.scoringMethod ?? "average" })),
    rubric: {
      criteria: [...(rubric.criteria ?? [])].sort((left, right) => left.key.localeCompare(right.key)).map((criterion) => ({ ...criterion, minimum: criterion.minimum ?? 0 })),
    },
    tiePolicy,
  };
  const plan: CompiledCapabilityPlan = {
    ok: true,
    capabilityKey: "competition",
    contentHash: capabilityDefinitionHash(definition),
    artifact: deepFreeze(artifact),
  };
  return deepFreeze(plan);
}

export const competitionCompiler: CapabilityCompiler = {
  capabilityKey: "competition",
  compile: compileCompetitionDefinition,
};

/**
 * The unconfigured shape a Pack may compile before anybody has designed the
 * rounds: one roster and one result, with nothing in between. It is a valid
 * definition, not a placeholder the competition compiler would refuse.
 */
export function createEmptyCompetitionDefinition(): CapabilityDefinition {
  return createCompetitionDefinition(
    [
      { key: "roster", type: "roster" },
      { key: "result", type: "output" },
    ],
    [{ from: "roster", to: "result" }],
  );
}

export const competitionCapability: CapabilityRegistration = deepFreeze({
  manifest: {
    identity: "competition",
    version: "1",
    dependencies: [],
    conflicts: [],
    definitionSchemaVersion: 1,
    commands: [
      "competition.configure",
      "competition.round.prepare",
      "competition.panel.activate",
      "competition.performance.open",
      "competition.performance.advance",
      "competition.performance.lock",
      "competition.round.lock",
      "competition.score.direct_judge",
      "competition.score.staff_rapid",
      "competition.score.staff_proxy",
      "competition.score.paper_dr",
      "competition.score.edit",
      "competition.score.correction.open",
      "competition.score.correction.close",
      "competition.score.correction.recalculate",
      "competition.ranking.resolve",
      "competition.advancement.finalize",
      "competition.tie.decide",
      "competition.podium.recompute",
    ],
    queries: ["competition.describe"],
    events: [
      "CompetitionConfigured",
      "CompetitionRoundPrepared",
      "PanelSnapshotActivated",
      "PerformanceAdvanced",
      "PerformanceLocked",
      "RoundLocked",
      "ScoreFactRecorded",
      "ScoreFactRevised",
      "ScoreCorrectionOpened",
      "ScoresRecalculated",
      "RankingComputed",
      "AdvancementFinalized",
      "TieDecisionRecorded",
      "StageResultCandidateProduced",
    ],
    permissions: ["competition.manage", "competition.round.prepare", "competition.score.write"],
    surfaces: ["studio", "ops", "live"],
    scopes: ["stage", "judging", "checkin", "voting"],
  },
  compiler: competitionCompiler,
  emptyDefinition: createEmptyCompetitionDefinition,
});
