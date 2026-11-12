import { readFileSync } from "node:fs";

export interface WarningAllowlistEntry {
  readonly match: string;
  readonly reason: string;
}

export interface WarningAllowlist {
  readonly version: 1;
  readonly accepted: readonly WarningAllowlistEntry[];
}

export function emptyWarningAllowlist(): WarningAllowlist {
  return { version: 1, accepted: [] };
}

export function readWarningAllowlist(pathname: string): WarningAllowlist {
  // A missing or malformed allowlist must fail loudly: swallowing it would
  // disable the strict ratchet exactly when the graph emits no warnings.
  let raw: Partial<WarningAllowlist>;
  try {
    raw = JSON.parse(readFileSync(pathname, "utf8")) as Partial<WarningAllowlist>;
  } catch (error) {
    throw new Error(`Cannot read the graph warning allowlist at ${pathname}: ${String(error)}`);
  }
  if (raw.version !== 1 || !Array.isArray(raw.accepted)) {
    throw new Error(`The graph warning allowlist at ${pathname} has an unsupported shape.`);
  }
  const accepted = raw.accepted.filter((entry): entry is WarningAllowlistEntry =>
    typeof entry === "object" && entry !== null &&
    typeof entry.match === "string" && entry.match.length > 0 &&
    typeof entry.reason === "string" && entry.reason.length > 0,
  );
  if (accepted.length !== raw.accepted.length) {
    throw new Error(`The graph warning allowlist at ${pathname} has an invalid entry.`);
  }
  return { version: 1, accepted };
}

export interface WarningCheck {
  readonly unaccepted: readonly string[];
  readonly stale: readonly string[];
}

/**
 * Every graph warning must be either absent or explicitly accepted with a
 * reason. A stale entry is also a failure: the warning disappeared and the
 * allowlist must shrink, not silently keep a blanket exemption.
 */
export function checkWarningAllowlist(
  warnings: readonly string[],
  allowlist: WarningAllowlist,
): WarningCheck {
  const used = new Set<number>();
  const unaccepted: string[] = [];
  for (const warning of warnings) {
    // Exact match: a prefix would accept every new warning of the same class.
    const index = allowlist.accepted.findIndex((entry) => warning === entry.match);
    if (index === -1) {
      unaccepted.push(warning);
    } else {
      used.add(index);
    }
  }
  const stale = allowlist.accepted
    .filter((_entry, index) => !used.has(index))
    .map((entry) => entry.match);
  return { unaccepted, stale };
}
