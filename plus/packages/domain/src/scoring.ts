import { createHash } from "node:crypto";
import { Decimal } from "decimal.js";

import { fail } from "./errors.js";
import { deepFreeze } from "./model.js";

export type ScoreSource = "direct_judge" | "staff_rapid" | "staff_proxy" | "paper_dr";
export type ScoreFactKey = string;
export type DecimalValue = string;
export type DecimalInput = DecimalValue | number;

export interface ScoringCriterion {
  readonly key: string;
  readonly weight: number;
  readonly maximum: number;
  readonly minimum?: number;
}

export interface ScoringRubric {
  readonly criteria: readonly ScoringCriterion[];
}

export interface ScoreSubmissionInput {
  readonly criteria: Readonly<Record<string, number>>;
  readonly notes: string;
}

export interface NormalizedScoreSubmission {
  readonly criteria: Readonly<Record<string, number>>;
  readonly total: DecimalValue;
  readonly notes: string;
  readonly canonicalPayload: Readonly<{ criteria: Readonly<Record<string, number>>; notes: string }>;
}

export interface ScoreRow {
  readonly contestantId: string;
  readonly total: DecimalValue;
  readonly judgeCount: number;
}

export interface ScoreRowInput {
  readonly contestantId: string;
  readonly total: DecimalInput;
  readonly judgeCount: number;
}

export interface TieGroup {
  readonly total: DecimalValue;
  readonly contestants: readonly string[];
}

export interface RankingResult {
  readonly status: "ready" | "hold";
  readonly rows: readonly ScoreRow[];
  readonly tieGroups: readonly TieGroup[];
  readonly inputFingerprint: string;
}

export interface TieDecision {
  readonly contestants: readonly string[];
  readonly order: readonly string[];
  readonly reason: string;
}

export function decimalValue(value: DecimalInput, decimals = 2): DecimalValue {
  return new Decimal(value).toDecimalPlaces(decimals, Decimal.ROUND_HALF_UP).toFixed(decimals);
}

export function roundScore(value: DecimalInput, decimals = 2): DecimalValue {
  return decimalValue(value, decimals);
}

export function compareScores(left: DecimalInput, right: DecimalInput): number {
  return new Decimal(left).comparedTo(new Decimal(right));
}

export function averageScore(values: readonly DecimalInput[], decimals = 2): DecimalValue {
  if (values.length === 0) throw new Error("Cannot average an empty score set.");
  const total = values.reduce((sum, value) => sum.plus(new Decimal(value)), new Decimal(0));
  return total.dividedBy(values.length).toDecimalPlaces(decimals, Decimal.ROUND_HALF_UP).toFixed(decimals);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([left], [right]) => left.localeCompare(right),
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  throw new Error("Scoring values must be JSON-serializable.");
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function scoreFactKey(roundId: string, contestantId: string, judgeId: string): ScoreFactKey {
  if (!roundId.trim() || !contestantId.trim() || !judgeId.trim()) {
    fail("INVALID_INPUT", "A score fact key needs round, contestant, and judge.");
  }
  return `${roundId}|${contestantId}|${judgeId}`;
}

export function normalizeScoreSubmission(
  input: ScoreSubmissionInput,
  rubric: ScoringRubric,
): NormalizedScoreSubmission {
  const criteria = input.criteria;
  const expected = new Map(rubric.criteria.map((criterion) => [criterion.key, criterion]));
  const providedKeys = Object.keys(criteria).sort();
  if (providedKeys.length !== expected.size || providedKeys.some((key) => !expected.has(key))) {
    fail("INVALID_INPUT", "Score criteria must exactly match the released rubric.");
  }
  const normalized: Record<string, number> = {};
  let total = new Decimal(0);
  for (const key of providedKeys) {
    const criterion = expected.get(key);
    const value = criteria[key];
    if (criterion === undefined || value === undefined || !Number.isFinite(value)) {
      fail("INVALID_INPUT", `Criterion ${key} is invalid.`);
    }
    const minimum = criterion.minimum ?? 0;
    if (value < minimum || value > criterion.maximum) fail("INVALID_INPUT", `Criterion ${key} is outside its allowed range.`);
    normalized[key] = value;
    total = total.plus(new Decimal(value).times(criterion.weight));
  }
  const roundedTotal = total.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
  const canonicalPayload = { criteria: normalized, notes: input.notes.trim() };
  return deepFreeze({ criteria: normalized, total: roundedTotal, notes: canonicalPayload.notes, canonicalPayload });
}

export function computeRanking(input: {
  readonly rows: readonly ScoreRowInput[];
  readonly tiePolicy: "review";
}): RankingResult {
  const rows: ScoreRow[] = input.rows
    .map((row) => ({ ...row, total: decimalValue(row.total) }))
    .sort((left, right) => compareScores(right.total, left.total));
  const tieGroups: TieGroup[] = [];
  for (let index = 0; index < rows.length;) {
    const current = rows[index];
    if (current === undefined) break;
    const group = rows.slice(index).filter((row) => compareScores(row.total, current.total) === 0);
    if (group.length > 1) tieGroups.push({ total: current.total, contestants: group.map((row) => row.contestantId) });
    index += group.length;
  }
  const result = {
    status: tieGroups.length > 0 ? "hold" as const : "ready" as const,
    rows,
    tieGroups,
    inputFingerprint: fingerprint(rows),
  };
  return deepFreeze(result);
}

export function applyTieDecision(ranking: RankingResult, decision: TieDecision): RankingResult {
  if (!decision.reason.trim() || decision.order.length !== decision.contestants.length) {
    fail("INVALID_INPUT", "A tie decision needs a reason and a complete order.");
  }
  const target = ranking.tieGroups.find((group) =>
    group.contestants.length === decision.contestants.length &&
    group.contestants.every((contestant) => decision.contestants.includes(contestant)));
  if (target === undefined || new Set(decision.order).size !== decision.order.length ||
      decision.order.some((contestant) => !decision.contestants.includes(contestant))) {
    fail("INVALID_INPUT", "A tie decision must order exactly one current tie group.");
  }
  const order = new Map(decision.order.map((contestant, index) => [contestant, index]));
  const rows = [...ranking.rows].sort((left, right) => {
    if (compareScores(left.total, right.total) !== 0) return compareScores(right.total, left.total);
    return (order.get(left.contestantId) ?? 0) - (order.get(right.contestantId) ?? 0);
  });
  const remainingTieGroups = ranking.tieGroups.filter((group) => group !== target);
  return deepFreeze({
    ...ranking,
    status: remainingTieGroups.length > 0 ? "hold" : "ready",
    rows,
    tieGroups: remainingTieGroups,
  });
}
