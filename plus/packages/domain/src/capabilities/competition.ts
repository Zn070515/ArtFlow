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

export interface CompetitionDefinition {
  readonly schemaVersion: 1;
  readonly nodes: readonly CompetitionNode[];
  readonly edges: readonly CompetitionEdge[];
}

export interface CompiledCompetitionArtifact {
  readonly order: readonly string[];
  readonly nodes: readonly CompetitionNode[];
  readonly edges: readonly CompetitionEdge[];
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
): CapabilityDefinition {
  const payload: CompetitionDefinition = { schemaVersion: 1, nodes, edges };
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
    commands: ["competition.configure"],
    queries: ["competition.describe"],
    events: ["CompetitionConfigured"],
    permissions: ["competition.manage", "competition.round.prepare"],
    surfaces: ["studio", "ops", "live"],
    scopes: ["stage", "judging", "checkin", "voting"],
  },
  compiler: competitionCompiler,
  emptyDefinition: createEmptyCompetitionDefinition,
});
