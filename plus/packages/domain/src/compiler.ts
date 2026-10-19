import { createHash } from "node:crypto";

import type {
  ActivityDefinitionPackage,
  CapabilityBinding,
  CapabilityCompileResult,
  CapabilityDefinition,
  CompileIssue,
  CompiledActivityDefinition,
  CompiledCapabilityPlan,
  DefinitionEdge,
  DefinitionNode,
  NodeType,
  PackageCompileResult,
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

function byBinding(left: CapabilityBinding, right: CapabilityBinding): number {
  const from = left.from < right.from ? -1 : left.from > right.from ? 1 : 0;
  if (from !== 0) return from;
  const to = left.to < right.to ? -1 : left.to > right.to ? 1 : 0;
  if (to !== 0) return to;
  return left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : 0;
}

function issue(code: string, message: string, path: string): CompileIssue {
  return { code, message, path };
}

/**
 * Stable canonical form: node and edge order never changes the hash, so two
 * capability definitions that mean the same thing are the same definition.
 */
export function canonicalCapabilityDefinition(definition: CapabilityDefinition): string {
  const nodes = [...definition.nodes]
    .sort(byKey)
    .map((node) => ({
      key: node.key,
      type: node.type,
      ...(node.label === undefined ? {} : { label: node.label }),
    }));
  const edges = [...definition.edges].sort(byEdge).map((edge) => ({
    from: edge.from,
    to: edge.to,
  }));
  return JSON.stringify({ schemaVersion: definition.schemaVersion, nodes, edges });
}

export function capabilityDefinitionHash(definition: CapabilityDefinition): string {
  return createHash("sha256").update(canonicalCapabilityDefinition(definition)).digest("hex");
}

export function compileCapabilityDefinition(
  capabilityKey: string,
  definition: CapabilityDefinition,
): CapabilityCompileResult {
  const issues: CompileIssue[] = [];
  if (definition.schemaVersion !== 1) {
    issues.push(issue("SCHEMA_VERSION", "Only schemaVersion 1 is supported.", "schemaVersion"));
  }
  if (definition.nodes.length === 0) {
    issues.push(issue("EMPTY_DEFINITION", "A definition needs at least one node.", "nodes"));
  }

  const keys = new Set<string>();
  const incoming = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const node of definition.nodes) {
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
  for (const edge of definition.edges) {
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
  for (const node of definition.nodes) {
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

  const plan: CompiledCapabilityPlan = {
    ok: true,
    capabilityKey,
    order,
    contentHash: capabilityDefinitionHash(definition),
    nodes: [...definition.nodes].sort(byKey).map((node) => ({ ...node })),
    edges: [...definition.edges].sort(byEdge).map((edge) => ({ ...edge })),
  };
  return deepFreeze(plan);
}

function canonicalPackage(pkg: ActivityDefinitionPackage): string {
  const capabilities = Object.keys(pkg.capabilities)
    .sort()
    .map((key) => {
      const definition = pkg.capabilities[key];
      return {
        key,
        hash: definition === undefined ? "" : capabilityDefinitionHash(definition),
      };
    });
  const bindings = [...(pkg.bindings ?? [])].sort(byBinding).map((binding) => ({
    from: binding.from,
    to: binding.to,
    kind: binding.kind,
  }));
  return JSON.stringify({
    schemaVersion: pkg.schemaVersion,
    manifest: { key: pkg.manifest.key, title: pkg.manifest.title },
    capabilities,
    bindings,
  });
}

export function activityDefinitionPackageHash(pkg: ActivityDefinitionPackage): string {
  return createHash("sha256").update(canonicalPackage(pkg)).digest("hex");
}

/**
 * The Activity compiler coordinates capability compilers and validates the
 * cross-capability bindings. It does not own any capability's language.
 */
export function compileActivityDefinitionPackage(
  pkg: ActivityDefinitionPackage,
): PackageCompileResult {
  const issues: CompileIssue[] = [];
  if (pkg.schemaVersion !== 1) {
    issues.push(issue("SCHEMA_VERSION", "Only schemaVersion 1 is supported.", "schemaVersion"));
  }
  if (!pkg.manifest.key.trim()) {
    issues.push(issue("MANIFEST_KEY", "The manifest needs a key.", "manifest.key"));
  }
  if (!pkg.manifest.title.trim()) {
    issues.push(issue("MANIFEST_TITLE", "The manifest needs a title.", "manifest.title"));
  }

  const capabilityKeys = Object.keys(pkg.capabilities);
  if (capabilityKeys.length === 0) {
    issues.push(
      issue("NO_CAPABILITIES", "An activity definition needs at least one capability.", "capabilities"),
    );
  }

  const compiled: Record<string, CompiledCapabilityPlan> = {};
  for (const key of capabilityKeys.sort()) {
    if (!key.trim()) {
      issues.push(issue("EMPTY_CAPABILITY_KEY", "A capability key cannot be empty.", "capabilities"));
      continue;
    }
    const definition = pkg.capabilities[key];
    if (definition === undefined) continue;
    const result = compileCapabilityDefinition(key, definition);
    if (!result.ok) {
      for (const item of result.issues) {
        issues.push(
          issue(
            `CAPABILITY_${item.code}`,
            `${key}: ${item.message}`,
            `capabilities.${key}.${item.path}`,
          ),
        );
      }
      continue;
    }
    compiled[key] = result;
  }

  const bindingKeys = new Set<string>();
  for (const binding of pkg.bindings ?? []) {
    if (!capabilityKeys.includes(binding.from) || !capabilityKeys.includes(binding.to)) {
      issues.push(
        issue(
          "BINDING_UNKNOWN_CAPABILITY",
          `Binding ${binding.from} -> ${binding.to} names an unknown capability.`,
          "bindings",
        ),
      );
      continue;
    }
    if (!binding.kind.trim()) {
      issues.push(issue("BINDING_KIND", "A binding needs a kind.", "bindings"));
      continue;
    }
    const bindingKey = `${binding.from}->${binding.to}:${binding.kind}`;
    if (bindingKeys.has(bindingKey)) {
      issues.push(issue("DUPLICATE_BINDING", `Duplicate binding: ${bindingKey}.`, bindingKey));
      continue;
    }
    bindingKeys.add(bindingKey);
  }

  if (issues.length > 0) {
    return deepFreeze({ ok: false, issues });
  }

  const result: CompiledActivityDefinition = {
    ok: true,
    contentHash: activityDefinitionPackageHash(pkg),
    capabilities: compiled,
  };
  return deepFreeze(result);
}
