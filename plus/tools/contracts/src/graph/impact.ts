import type { ConsumerGraph, GraphEdge, GraphNode, NodeKind } from "./schema.js";

export interface ImpactedNode {
  readonly node: GraphNode;
  readonly direction: "forward" | "reverse";
  readonly depth: number;
  readonly via?: GraphEdge;
}

export interface ImpactReport {
  readonly starts: readonly GraphNode[];
  readonly nodes: readonly ImpactedNode[];
}

const FORWARD_KINDS = new Set<GraphEdge["kind"]>(["invokes-command", "emits"]);
const REVERSE_EXCLUDED = new Set<GraphEdge["kind"]>(["imports"]);

function indexGraph(graph: ConsumerGraph): {
  readonly nodes: ReadonlyMap<string, GraphNode>;
  readonly forward: ReadonlyMap<string, readonly GraphEdge[]>;
  readonly reverse: ReadonlyMap<string, readonly GraphEdge[]>;
} {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const forward = new Map<string, GraphEdge[]>();
  const reverse = new Map<string, GraphEdge[]>();
  for (const edge of graph.edges) {
    const outgoing = forward.get(edge.from) ?? [];
    outgoing.push(edge);
    forward.set(edge.from, outgoing);
    const incoming = reverse.get(edge.to) ?? [];
    incoming.push(edge);
    reverse.set(edge.to, incoming);
  }
  return { nodes, forward, reverse };
}

export function impactOf(
  graph: ConsumerGraph,
  startIds: readonly string[],
  options: { readonly forwardDepth?: number; readonly reverseDepth?: number } = {},
): ImpactReport {
  const { nodes, forward, reverse } = indexGraph(graph);
  const forwardDepth = options.forwardDepth ?? 1;
  const reverseDepth = options.reverseDepth ?? 8;
  const starts = startIds
    .map((id) => nodes.get(id))
    .filter((node): node is GraphNode => node !== undefined);
  const impacted = new Map<string, ImpactedNode>();
  for (const start of starts) {
    impacted.set(start.id, { node: start, direction: "reverse", depth: 0 });
  }

  const forwardQueue: { id: string; depth: number }[] = starts.map((node) => ({ id: node.id, depth: 0 }));
  const forwardSeen = new Set(forwardQueue.map((item) => item.id));
  while (forwardQueue.length > 0) {
    const current = forwardQueue.shift();
    if (current === undefined || current.depth >= forwardDepth) continue;
    for (const edge of forward.get(current.id) ?? []) {
      if (!FORWARD_KINDS.has(edge.kind)) continue;
      const target = nodes.get(edge.to);
      if (target === undefined) continue;
      if (!impacted.has(target.id)) {
        impacted.set(target.id, {
          node: target,
          direction: "forward",
          depth: current.depth + 1,
          via: edge,
        });
      }
      if (!forwardSeen.has(target.id)) {
        forwardSeen.add(target.id);
        forwardQueue.push({ id: target.id, depth: current.depth + 1 });
      }
    }
  }

  const reverseQueue = [...impacted.keys()].map((id) => ({ id, depth: 0 }));
  const reverseSeen = new Set(reverseQueue.map((item) => item.id));
  while (reverseQueue.length > 0) {
    const current = reverseQueue.shift();
    if (current === undefined || current.depth >= reverseDepth) continue;
    for (const edge of reverse.get(current.id) ?? []) {
      if (REVERSE_EXCLUDED.has(edge.kind)) continue;
      const source = nodes.get(edge.from);
      if (source === undefined) continue;
      if (!impacted.has(source.id)) {
        impacted.set(source.id, {
          node: source,
          direction: "reverse",
          depth: current.depth + 1,
          via: edge,
        });
      }
      if (!reverseSeen.has(source.id)) {
        reverseSeen.add(source.id);
        reverseQueue.push({ id: source.id, depth: current.depth + 1 });
      }
    }
  }

  return {
    starts,
    nodes: [...impacted.values()].sort((left, right) => {
      if (left.depth !== right.depth) return left.depth - right.depth;
      if (left.node.kind !== right.node.kind) return left.node.kind < right.node.kind ? -1 : 1;
      return left.node.id < right.node.id ? -1 : left.node.id > right.node.id ? 1 : 0;
    }),
  };
}

export function findStartNodes(
  graph: ConsumerGraph,
  selector: { kind: NodeKind; value: string },
): GraphNode[] {
  const value = selector.value.replace(/^file:/, "");
  return graph.nodes.filter((node) => {
    if (selector.kind === "file") return node.kind === "file" && (node.name === value || node.file === value);
    return node.kind === selector.kind && node.name === selector.value;
  });
}

function markdownCell(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\r\n|\r|\n/g, " ");
}

export function formatImpactReport(report: ImpactReport, title: string): string {
  const lines: string[] = [`# Consumer impact: ${title}`, ""];
  if (report.starts.length === 0) {
    lines.push("No start node matched.", "");
    return lines.join("\n");
  }
  lines.push("## Start", "");
  for (const node of report.starts) {
    lines.push(`- \`${node.kind}\` ${node.name}${node.file === undefined ? "" : ` (${node.file}${node.line === undefined ? "" : `:${node.line}`})`}`);
  }
  lines.push("", "## Impacted nodes", "");
  if (report.nodes.length <= report.starts.length) {
    lines.push("No downstream consumers found.", "");
    return lines.join("\n");
  }
  lines.push("| Kind | Name | File | Line | Direction | Depth | Via |");
  lines.push("| --- | --- | --- | ---: | --- | ---: | --- |");
  for (const item of report.nodes) {
    if (report.starts.some((start) => start.id === item.node.id)) continue;
    lines.push(
      `| ${item.node.kind} | ${markdownCell(item.node.name)} | ${markdownCell(item.node.file ?? "")} | ${item.node.line ?? ""} | ${item.direction} | ${item.depth} | ${item.via?.kind ?? ""} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}
