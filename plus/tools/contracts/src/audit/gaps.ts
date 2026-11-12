import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import {
  REVIEW_AWARDS_PACK,
  SINGER_COMPETITION_PACK,
  STAGE_SHOW_PACK,
} from "@artflow-plus/domain";

import type { ConsumerGraph } from "../graph/schema.js";
import { findUnreferencedMutationRoutes } from "../graph/ui.js";
import { checkPackReadiness } from "../harness/readiness.js";

export type GapKind =
  | "ui-route"
  | "pack-readiness"
  | "manifest"
  | "doc-drift"
  | "deploy-manifest"
  | "invariant-coverage";

export interface TestGap {
  readonly id: string;
  readonly kind: GapKind;
  readonly subject: string;
  readonly detail: string;
}

const ENGINE_COMMAND_PREFIXES = ["activity.", "definition.", "execution.", "runtime."];
const ENGINE_EVENT_PREFIXES = ["Activity", "Definition"];
const ENGINE_EVENTS = new Set(["ExecutionSessionStarted", "ExecutionSessionClosed"]);

function gap(kind: GapKind, subject: string, detail: string): TestGap {
  return { id: `${kind}:${subject}`, kind, subject, detail };
}

function read(root: string, relative: string): string | null {
  try {
    return readFileSync(path.join(root, relative), "utf8");
  } catch {
    return null;
  }
}

export function uiGaps(graph: ConsumerGraph, apiOnly: ReadonlySet<string> = new Set()): TestGap[] {
  return findUnreferencedMutationRoutes(graph, apiOnly).map((route) =>
    gap(
      "ui-route",
      `${route.method} ${route.path}`,
      `Mutation route has no Web caller; file ${route.file ?? "unknown"}:${route.line ?? 0}.`,
    ),
  );
}

export function packReadinessGaps(): TestGap[] {
  return checkPackReadiness([
    SINGER_COMPETITION_PACK,
    STAGE_SHOW_PACK,
    REVIEW_AWARDS_PACK,
  ]).map((finding) =>
    gap("pack-readiness", `${finding.pack}:${finding.code}`, finding.message),
  );
}

export function manifestGaps(graph: ConsumerGraph): TestGap[] {
  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const to = incoming.get(edge.to) ?? [];
    to.push(edge.kind);
    incoming.set(edge.to, to);
    const from = outgoing.get(edge.from) ?? [];
    from.push(edge.kind);
    outgoing.set(edge.from, from);
  }
  const gaps: TestGap[] = [];
  for (const node of graph.nodes) {
    if (node.kind === "command") {
      const kinds = incoming.get(node.id) ?? [];
      if (!kinds.includes("invokes-command")) {
        gaps.push(gap("manifest", `command-no-provider:${node.name}`, "No executeCommand provider in the source tree."));
      }
      if (
        !kinds.includes("declares") &&
        !ENGINE_COMMAND_PREFIXES.some((prefix) => node.name.startsWith(prefix))
      ) {
        gaps.push(gap("manifest", `command-undeclared:${node.name}`, "No capability manifest declares this command."));
      }
    }
    if (node.kind === "event") {
      const kinds = incoming.get(node.id) ?? [];
      const engine =
        ENGINE_EVENTS.has(node.name) ||
        ENGINE_EVENT_PREFIXES.some((prefix) => node.name.startsWith(prefix));
      if (!kinds.includes("emits")) {
        gaps.push(gap("manifest", `event-no-producer:${node.name}`, "No appendEngineEvent producer in the source tree."));
      }
      if (!engine && !kinds.includes("consumes")) {
        gaps.push(gap("manifest", `event-no-consumer:${node.name}`, "No declared event consumer."));
      }
      if (!engine && !kinds.includes("declares")) {
        gaps.push(gap("manifest", `event-undeclared:${node.name}`, "No capability manifest declares this event."));
      }
    }
  }
  return gaps;
}

const ACTIVE_DOCS = [
  "README.md",
  "plus/README.md",
  "docs/deployment-production.md",
  "docs/development-baseline.md",
  "docs/artflow-plus/README.md",
];

const DOC_DRIFT_PATTERNS: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  { label: "/register/admin/", pattern: /\/register\/admin\// },
  { label: "ADMIN_ACCESS_KEY", pattern: /ADMIN_ACCESS_KEY/ },
  { label: "Gunicorn", pattern: /\bGunicorn\b/i },
  { label: "scripts/deploy.sh", pattern: /scripts\/deploy\.sh/ },
  { label: "artflow-web", pattern: /\bartflow-web\b/ },
];

export function docDriftGaps(root: string): TestGap[] {
  const gaps: TestGap[] = [];
  for (const file of ACTIVE_DOCS) {
    const text = read(root, file);
    if (text === null) continue;
    for (const drift of DOC_DRIFT_PATTERNS) {
      if (drift.pattern.test(text)) {
        gaps.push(gap("doc-drift", `${file}:${drift.label}`, "Active documentation references a removed 1.x entrypoint."));
      }
    }
  }
  return gaps;
}

export function deployManifestGaps(root: string): TestGap[] {
  const gaps: TestGap[] = [];
  const compose = read(root, "deploy/compose.production.yml");
  if (compose !== null && /plus_postgres_data:\/var\/lib\/postgresql\/data/.test(compose)) {
    gaps.push(gap(
      "deploy-manifest",
      "compose.plus-db.volume-path",
      "PostgreSQL 18 must mount /var/lib/postgresql, not /var/lib/postgresql/data.",
    ));
  }
  const k8s = read(root, "deploy/k8s/base/db.yaml");
  if (k8s !== null) {
    const correct = /mountPath:\s*["']?\/var\/lib\/postgresql["']?\s*$/m.test(k8s);
    const wrong = /mountPath:\s*["']?\/var\/lib\/postgresql\/data["']?\s*$/m.test(k8s);
    if (!correct || wrong) {
      gaps.push(gap(
        "deploy-manifest",
        "k8s.plus-db.mount-path",
        "The k8s database manifest must mount /var/lib/postgresql, not /var/lib/postgresql/data.",
      ));
    }
  }
  return gaps;
}

const INVARIANT_PATTERN = /\b(?:AUTH|LIFE|GRP|CONC|SCOR|RES|TICK|ATT|DEPL|RT)-\d+\b/g;

function walkFiles(root: string, relative: string, extensions: readonly string[], output: string[]): void {
  let stats;
  try {
    stats = statSync(path.join(root, relative));
  } catch {
    return;
  }
  if (!stats.isDirectory()) {
    if (extensions.some((extension) => relative.endsWith(extension))) output.push(relative);
    return;
  }
  for (const entry of readdirSync(path.join(root, relative))) {
    if (entry === "node_modules" || entry === "dist" || entry === "test-results") continue;
    walkFiles(root, path.join(relative, entry), extensions, output);
  }
}

export function invariantCoverageGaps(root: string): TestGap[] {
  const invariantFiles: string[] = [];
  walkFiles(root, "docs/invariants", [".md"], invariantFiles);
  const ids = new Set<string>();
  for (const file of invariantFiles) {
    const text = read(root, file);
    if (text === null) continue;
    for (const match of text.matchAll(INVARIANT_PATTERN)) ids.add(match[0]);
  }

  const testFiles: string[] = [];
  for (const relative of [
    "plus/packages",
    "plus/apps",
    "plus/tools/contracts/test",
    "tests/gates",
    "tests/golden",
  ]) {
    walkFiles(root, relative, [".ts", ".tsx", ".py", ".json"], testFiles);
  }
  const testText = testFiles
    .filter((file) => /(?:test|spec|gate|golden)/i.test(file))
    .map((file) => read(root, file) ?? "")
    .join("\n");
  // Match whole ids, not substrings: LIFE-10 must not cover LIFE-1.
  const referenced = new Set<string>();
  for (const match of testText.matchAll(INVARIANT_PATTERN)) referenced.add(match[0]);

  return [...ids].sort().flatMap((id) =>
    referenced.has(id)
      ? []
      : [gap("invariant-coverage", id, "No test file references this invariant id.")],
  );
}

export function runGapAudit(
  plusRoot: string,
  graph: ConsumerGraph,
  include: {
    readonly ui?: boolean;
    readonly packs?: boolean;
    readonly manifest?: boolean;
    readonly docs?: boolean;
    readonly deploy?: boolean;
    readonly invariants?: boolean;
  } = {},
  repoRoot = path.dirname(plusRoot),
  apiOnly: ReadonlySet<string> = new Set(),
): TestGap[] {
  const all = [
    ...(include.ui === false ? [] : uiGaps(graph, apiOnly)),
    ...(include.packs === false ? [] : packReadinessGaps()),
    ...(include.manifest === false ? [] : manifestGaps(graph)),
    ...(include.docs === false ? [] : docDriftGaps(repoRoot)),
    ...(include.deploy === false ? [] : deployManifestGaps(repoRoot)),
    ...(include.invariants === false ? [] : invariantCoverageGaps(repoRoot)),
  ];
  const byId = new Map<string, TestGap>();
  for (const item of all) byId.set(item.id, item);
  return [...byId.values()].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}
