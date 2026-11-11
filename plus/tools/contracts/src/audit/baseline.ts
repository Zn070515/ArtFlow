import { readFileSync, writeFileSync } from "node:fs";

import type { TestGap } from "./gaps.js";

export interface BaselineEntry {
  readonly id: string;
  readonly reason: string;
  readonly issue?: string;
}

export interface GapBaseline {
  readonly version: 1;
  readonly accepted: readonly BaselineEntry[];
}

export function emptyBaseline(): GapBaseline {
  return { version: 1, accepted: [] };
}

export function readBaseline(path: string): GapBaseline {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<GapBaseline>;
    if (raw.version !== 1 || !Array.isArray(raw.accepted)) return emptyBaseline();
    return {
      version: 1,
      accepted: raw.accepted.filter((entry): entry is BaselineEntry =>
        typeof entry === "object" &&
        entry !== null &&
        typeof entry.id === "string" &&
        typeof entry.reason === "string",
      ),
    };
  } catch {
    return emptyBaseline();
  }
}

export function writeBaseline(path: string, gaps: readonly TestGap[]): void {
  const accepted = gaps.map((gap) => ({
    id: gap.id,
    reason: knownReason(gap.id),
    ...(knownIssue(gap.id) === undefined ? {} : { issue: knownIssue(gap.id) }),
  }));
  writeFileSync(path, `${JSON.stringify({ version: 1, accepted }, null, 2)}\n`, "utf8");
}

/** Stable issue mapping for the initial external-review baseline. */
function knownIssue(id: string): string | undefined {
  if (id.includes("/tasks/sync")) return "#61";
  if (id.includes("/podium/recompute") || id.includes("/close") || id.includes("/archive")) return "#60";
  if (id.includes("/judge-entry/close")) return "#54";
  if (id.includes("singer-competition:MATERIALS_WITHOUT_FILE_QUESTION")) return "#55";
  if (id.includes("JUDGING_WITHOUT_TICKETING")) return "#54";
  if (id.includes("VOTING_IDENTITY_IMPLICIT")) return "#59";
  if (id.includes("doc-drift:docs/deployment-production.md")) return "#52";
  if (id.includes("compose.plus-db.volume-path")) return "#51";
  return undefined;
}

function knownReason(id: string): string {
  if (id.startsWith("ui-route:")) return "No web caller yet; accepted in the 2026-11-11 baseline.";
  if (id.startsWith("pack-readiness:")) return "Starter pack readiness gap; accepted in the 2026-11-11 baseline.";
  if (id.startsWith("manifest:")) return "Manifest/consumer declaration gap; accepted in the 2026-11-11 baseline.";
  if (id.startsWith("doc-drift:")) return "Active documentation drift; accepted in the 2026-11-11 baseline.";
  if (id.startsWith("deploy-manifest:")) return "Deployment manifest drift; accepted in the 2026-11-11 baseline.";
  if (id.startsWith("invariant-coverage:")) return "Invariant has no explicit test reference yet; accepted in the 2026-11-11 baseline.";
  return "Accepted in the 2026-11-11 baseline.";
}

export interface GapComparison {
  readonly newGaps: readonly TestGap[];
  readonly stale: readonly BaselineEntry[];
}

/**
 * A ratchet: new gaps fail, and a fixed gap must have its baseline entry
 * removed. This keeps the accepted set from rotting after fixes.
 */
export function compareBaseline(
  gaps: readonly TestGap[],
  baseline: GapBaseline,
): GapComparison {
  const current = new Set(gaps.map((gap) => gap.id));
  const accepted = new Set(baseline.accepted.map((entry) => entry.id));
  return {
    newGaps: gaps.filter((gap) => !accepted.has(gap.id)),
    stale: baseline.accepted.filter((entry) => !current.has(entry.id)),
  };
}
