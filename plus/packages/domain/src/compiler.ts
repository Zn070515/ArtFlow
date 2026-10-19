import { createHash } from "node:crypto";

import type {
  CompiledPlan,
  CompileIssue,
  CompileResult,
  DefinitionDocument,
  DefinitionEdge,
  DefinitionNode,
  NodeType,
} from "./model.js";
import { deepFreeze } from "./model.js";

const NODE_TYPES: ReadonlySet<NodeType> = new Set([
  "roster",
  "round",
  "aggregate",
  "output",
]);

function byKey(left: DefinitionNode, right: DefinitionNode): number {
  if (left.key < right.key) return -1;
  if (left.key > right.key) return 1;
  return 0;
}

function byEdge(left: DefinitionEdge, right: DefinitionEdge): number {
  const from = left.from < right.from ? -1 : left.from > right.from ? 1 : 0;
  if (from !== 0) return from;
  if (left.to < right.to) return -1;
  if (left.to > right.to) return 1;
  return 0;
}

function issue(code: string, message: string, path: string): CompileIssue {
  return { code, message, path };
}

/**
 * Stable canonical form: node and edge order never changes the content hash,
 * so two documents that mean the same thing are the same definition.
 */
export function canonicalDefinition(document: DefinitionDocument): string {
  const nodes = [...document.nodes]
    .sort(byKey)
    .map((node) => ({
      key: node.key,
      type: node.type,
      ...(node.label === undefined ? {} : { label: node.label }),
    }));
  const edges = [...document.edges].sort(byEdge).map((edge) => ({
    from: edge.from,
    to: edge.to,
  }));
  return JSON.stringify({ schemaVersion: document.schemaVersion, nodes, edges });
}

export function definitionHash(document: DefinitionDocument): string {
  return createHash("sha256").update(canonicalDefinition(document)).digest("hex");
}

export function compileDefinition(document: DefinitionDocument): CompileResult {
  const issues: CompileIssue[] = [];
  if (document.schemaVersion !== 1) {
    issues.push(issue("SCHEMA_VERSION", "Only schemaVersion 1 is supported.", "schemaVersion"));
  }
  if (document.nodes.length === 0) {
    issues.push(issue("EMPTY_DEFINITION", "A definition needs at least one node.", "nodes"));
  }

  const keys = new Set<string>();
  const incoming = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const node of document.nodes) {
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
  for (const edge of document.edges) {
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
  for (const node of document.nodes) {
    if (!keys.has(node.key)) continue;
    if (node.type === "output") outputCount += 1;
    if (node.type !== "roster" && (incoming.get(node.key) ?? 0) === 0) {
      issues.push(
        issue("ORPHAN_NODE", `Node ${node.key} has no incoming edge.`, node.key),
      );
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

  const plan: CompiledPlan = {
    ok: true,
    order,
    contentHash: definitionHash(document),
    nodes: [...document.nodes].sort(byKey).map((node) => ({ ...node })),
    edges: [...document.edges].sort(byEdge).map((edge) => ({ ...edge })),
  };
  return deepFreeze(plan);
}
