/**
 * Consumer graph nodes and edges. The graph is a prototype: it is deliberately
 * smaller than the TypeScript program graph and only models the boundaries the
 * contract program needs. Dynamic seams are declared in dynamic-dependencies.json.
 */

export type NodeKind =
  | "file"
  | "module"
  | "symbol"
  | "capability"
  | "command"
  | "event"
  | "topic"
  | "table"
  | "route";

export type EdgeKind =
  | "imports"
  | "calls"
  | "invokes-command"
  | "emits"
  | "consumes"
  | "declares"
  | "depends-on"
  | "subscribes"
  | "reads"
  | "writes"
  | "serves";

export interface GraphNode {
  readonly id: string;
  readonly kind: NodeKind;
  readonly name: string;
  readonly file?: string;
  readonly line?: number;
}

export interface GraphEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: EdgeKind;
  readonly file?: string;
  readonly line?: number;
}

export type UnresolvedKind =
  | "import"
  | "binding"
  | "command"
  | "event"
  | "capability"
  | "topic"
  | "dynamic"
  | "route";

export interface UnresolvedReference {
  readonly kind: UnresolvedKind;
  readonly value: string;
  readonly file?: string;
  readonly line?: number;
  readonly reason: string;
}

export interface SourceFile {
  readonly path: string;
  readonly text: string;
}

export interface ConsumerGraph {
  readonly version: 1;
  readonly root: string;
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly unresolved: readonly UnresolvedReference[];
  readonly warnings: readonly string[];
}

export interface GraphSummary {
  readonly nodes: number;
  readonly edges: number;
  readonly unresolved: number;
  readonly warnings: number;
  readonly byKind: Readonly<Record<string, number>>;
  readonly byEdgeKind: Readonly<Record<string, number>>;
}

export function fileNodeId(file: string): string {
  return `file:${file}`;
}

export function moduleNodeId(specifier: string): string {
  return `module:${specifier}`;
}

export function symbolNodeId(file: string, name: string): string {
  return `symbol:${file}#${name}`;
}

export function capabilityNodeId(identity: string): string {
  return `capability:${identity}`;
}

export function commandNodeId(commandType: string): string {
  return `command:${commandType}`;
}

export function eventNodeId(eventType: string): string {
  return `event:${eventType}`;
}

export function topicNodeId(namespace: string): string {
  return `topic:${namespace}`;
}

export function tableNodeId(table: string): string {
  return `table:${table}`;
}

export function routeNodeId(method: string, url: string): string {
  return `route:${method.toUpperCase()} ${url}`;
}

export function summarizeGraph(graph: ConsumerGraph): GraphSummary {
  const byKind: Record<string, number> = {};
  for (const node of graph.nodes) byKind[node.kind] = (byKind[node.kind] ?? 0) + 1;
  const byEdgeKind: Record<string, number> = {};
  for (const edge of graph.edges) {
    byEdgeKind[edge.kind] = (byEdgeKind[edge.kind] ?? 0) + 1;
  }
  return {
    nodes: graph.nodes.length,
    edges: graph.edges.length,
    unresolved: graph.unresolved.length,
    warnings: graph.warnings.length,
    byKind,
    byEdgeKind,
  };
}

export function sortGraph(
  nodes: Iterable<GraphNode>,
  edges: Iterable<GraphEdge>,
  unresolved: Iterable<UnresolvedReference>,
  warnings: Iterable<string>,
): Pick<ConsumerGraph, "nodes" | "edges" | "unresolved" | "warnings"> {
  const sortedNodes = [...nodes].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  );
  const sortedEdges = [...edges].sort((left, right) => {
    const leftKey = `${left.from}|${left.to}|${left.kind}|${left.file ?? ""}|${left.line ?? 0}`;
    const rightKey = `${right.from}|${right.to}|${right.kind}|${right.file ?? ""}|${right.line ?? 0}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  const sortedUnresolved = [...unresolved].sort((left, right) => {
    const leftKey = `${left.kind}|${left.file ?? ""}|${left.line ?? 0}|${left.value}`;
    const rightKey = `${right.kind}|${right.file ?? ""}|${right.line ?? 0}|${right.value}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  return {
    nodes: Object.freeze(sortedNodes),
    edges: Object.freeze(sortedEdges),
    unresolved: Object.freeze(sortedUnresolved),
    warnings: Object.freeze([...warnings].sort()),
  };
}
