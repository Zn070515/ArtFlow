import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { buildConsumerGraph } from "../graph/build.js";
import { loadDynamicDependencies } from "../graph/dynamic.js";
import { compareBaseline, readBaseline, writeBaseline } from "./baseline.js";
import { runGapAudit } from "./gaps.js";
import type { TestGap } from "./gaps.js";

interface Arguments {
  readonly check: boolean;
  readonly update: boolean;
  readonly root: string;
}

function parseArgs(argv: readonly string[]): Arguments {
  const rootFlag = argv.indexOf("--root");
  return {
    check: argv.includes("--check"),
    update: argv.includes("--update"),
    root: rootFlag >= 0 && argv[rootFlag + 1] !== undefined
      ? path.resolve(argv[rootFlag + 1] as string)
      : path.resolve(import.meta.dirname, "../../../.."),
  };
}

function byKind(gaps: readonly TestGap[]): Map<string, TestGap[]> {
  const grouped = new Map<string, TestGap[]>();
  for (const gap of gaps) {
    const list = grouped.get(gap.kind) ?? [];
    list.push(gap);
    grouped.set(gap.kind, list);
  }
  return grouped;
}

function printGaps(gaps: readonly TestGap[]): void {
  for (const [kind, entries] of [...byKind(gaps)].sort(([left], [right]) => (left < right ? -1 : 1))) {
    process.stdout.write(`\n${kind} (${entries.length}):\n`);
    for (const entry of entries) process.stdout.write(`- ${entry.id}\n`);
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const plusRoot = args.root;
  const repoRoot = path.dirname(plusRoot);
  const dynamic = loadDynamicDependencies(path.resolve(import.meta.dirname, "../../dynamic-dependencies.json"));
  const graph = buildConsumerGraph(plusRoot, dynamic);
  const gaps = runGapAudit(plusRoot, graph, {}, repoRoot);
  const baselinePath = path.resolve(import.meta.dirname, "../../gap-baseline.json");
  const artifactDirectory = path.join(plusRoot, ".artifacts");
  mkdirSync(artifactDirectory, { recursive: true });
  const artifactPath = path.join(artifactDirectory, "gap-audit.json");
  writeFileSync(
    artifactPath,
    `${JSON.stringify({ gaps, baseline: path.basename(baselinePath) }, null, 2)}\n`,
    "utf8",
  );

  if (args.update) {
    writeBaseline(baselinePath, gaps);
    process.stdout.write(`Gap baseline updated: ${gaps.length} accepted gap(s).\n`);
    return;
  }

  if (args.check) {
    const baseline = readBaseline(baselinePath);
    const comparison = compareBaseline(gaps, baseline);
    if (comparison.newGaps.length > 0) {
      process.stderr.write(`New test gaps (${comparison.newGaps.length}):\n`);
      for (const gap of comparison.newGaps) process.stderr.write(`- ${gap.id}: ${gap.detail}\n`);
    }
    if (comparison.stale.length > 0) {
      process.stderr.write(`Stale baseline entries (${comparison.stale.length}); remove them after a fix:\n`);
      for (const entry of comparison.stale) process.stderr.write(`- ${entry.id}\n`);
    }
    if (comparison.newGaps.length > 0 || comparison.stale.length > 0) {
      process.stderr.write(`\nGap audit failed. Current gaps: ${gaps.length}; accepted: ${baseline.accepted.length}.\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`Gap audit passed: ${gaps.length} accepted gap(s), no new or stale entries.\n`);
    return;
  }

  process.stdout.write(`Gap audit: ${gaps.length} gap(s).\n`);
  printGaps(gaps);
  process.stdout.write(`\nReport written to ${artifactPath}\n`);
}

main();
