import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { buildConsumerGraph } from "./build.js";
import { loadDynamicDependencies } from "./dynamic.js";
import { findStartNodes, formatImpactReport, impactOf } from "./impact.js";
import { plusRelative } from "./paths.js";
import { summarizeGraph } from "./schema.js";
import type { NodeKind } from "./schema.js";
import { findUnreferencedMutationRoutes, formatUiGaps } from "./ui.js";

interface Arguments {
  readonly command: string;
  readonly flags: ReadonlyMap<string, string | true>;
}

function parseArgs(argv: readonly string[]): Arguments {
  const [command = "graph", ...rest] = argv;
  const flags = new Map<string, string | true>();
  for (let index = 0; index < rest.length; index += 1) {
    const item = rest[index];
    if (item === undefined || !item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = rest[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(key, next);
      index += 1;
    } else {
      flags.set(key, true);
    }
  }
  return { command, flags };
}

function defaultRoot(): string {
  return path.resolve(import.meta.dirname, "../../../..");
}

function dynamicPath(): string {
  return path.resolve(import.meta.dirname, "../../dynamic-dependencies.json");
}

function artifactPath(root: string, name: string): string {
  const directory = path.join(root, ".artifacts");
  mkdirSync(directory, { recursive: true });
  return path.join(directory, name);
}

function writeJson(pathname: string, value: unknown): void {
  writeFileSync(pathname, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function changedFiles(root: string, base: string): string[] {
  const output = execFileSync("git", ["diff", "--name-only", `${base}...HEAD`], {
    cwd: root,
    encoding: "utf8",
  });
  return output
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/\\/g, "/"))
    .filter(Boolean);
}

function selectorFromArgs(flags: Arguments["flags"]): { kind: NodeKind; value: string } | null {
  const pairs: [string, NodeKind][] = [
    ["symbol", "symbol"],
    ["file", "file"],
    ["command", "command"],
    ["event", "event"],
    ["topic", "topic"],
    ["route", "route"],
  ];
  for (const [flag, kind] of pairs) {
    const value = flags.get(flag);
    if (typeof value === "string") return { kind, value };
  }
  return null;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const root = typeof args.flags.get("root") === "string" ? String(args.flags.get("root")) : defaultRoot();
  const dynamic = loadDynamicDependencies(dynamicPath());
  const graph = buildConsumerGraph(root, dynamic);
  const summary = summarizeGraph(graph);

  if (args.command === "graph") {
    const output = typeof args.flags.get("out") === "string"
      ? String(args.flags.get("out"))
      : artifactPath(root, "consumer-graph.json");
    writeJson(output, graph);
    const uiGaps = findUnreferencedMutationRoutes(graph);
    const gapPath = artifactPath(root, "ui-gaps.json");
    writeJson(gapPath, uiGaps);
    process.stdout.write(`${JSON.stringify({ output, uiGaps: uiGaps.length, uiGapsOutput: gapPath, ...summary }, null, 2)}\n`);
    if (uiGaps.length > 0) {
      process.stdout.write(`\n${formatUiGaps(uiGaps)}`);
    }
    if (graph.warnings.length > 0) {
      process.stdout.write(`\nWarnings (${graph.warnings.length}):\n`);
      for (const warning of graph.warnings) process.stdout.write(`- ${warning}\n`);
    }
    if (graph.unresolved.length > 0) {
      process.stderr.write(`\nUnresolved (${graph.unresolved.length}):\n`);
      for (const item of graph.unresolved) {
        process.stderr.write(`- [${item.kind}] ${item.value}${item.file === undefined ? "" : ` (${item.file}:${item.line ?? 0})`}: ${item.reason}\n`);
      }
    }
    if (args.flags.get("check") === true && graph.unresolved.length > 0) {
      process.exitCode = 1;
    }
    return;
  }

  if (args.command !== "impact") {
    process.stderr.write(`Unknown command: ${args.command}\n`);
    process.exitCode = 2;
    return;
  }

  const selector = selectorFromArgs(args.flags);
  const base = args.flags.get("base");
  const startIds = new Set<string>();
  let title = "changed files";

  if (selector !== null) {
    const starts = findStartNodes(graph, selector);
    if (starts.length === 0) {
      process.stderr.write(`No ${selector.kind} matched ${selector.value}.\n`);
      process.exitCode = 1;
      return;
    }
    for (const node of starts) startIds.add(node.id);
    title = `${selector.kind} ${selector.value}`;
  } else if (typeof base === "string") {
    const changed = changedFiles(root, base);
    title = `${base}...HEAD (${changed.length} changed files)`;
    for (const file of changed) {
      const relative = plusRelative(file);
      const fileNode = graph.nodes.find((node) => node.kind === "file" && (node.name === relative || node.file === relative));
      if (fileNode !== undefined) startIds.add(fileNode.id);
      for (const node of graph.nodes) {
        if (node.kind === "symbol" && node.file === relative) startIds.add(node.id);
      }
    }
    if (startIds.size === 0) {
      const message = `No graph nodes matched the changed files from ${base}...HEAD.\n`;
      if (args.flags.get("allow-empty") === true) {
        process.stdout.write(message);
        writeFileSync(artifactPath(root, "contract-impact.md"), message, "utf8");
        return;
      }
      process.stderr.write(message);
      process.exitCode = 1;
      return;
    }
  } else {
    process.stderr.write("Provide one of --symbol, --file, --command, --event, --topic, --route, or --base.\n");
    process.exitCode = 2;
    return;
  }

  const report = impactOf(graph, [...startIds]);
  const markdown = formatImpactReport(report, title);
  process.stdout.write(markdown);
  const output = typeof args.flags.get("out") === "string"
    ? String(args.flags.get("out"))
    : artifactPath(root, "contract-impact.md");
  writeFileSync(output, markdown, "utf8");
  process.stdout.write(`\nReport written to ${output}\n`);
}

main();
