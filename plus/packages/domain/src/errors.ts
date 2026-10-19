export type DomainErrorCode =
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "QUESTION_UNKNOWN"
  | "MATERIAL_NOT_ALLOWED"
  | "ROSTER_UNKNOWN"
  | "STALE_REVISION"
  | "INVALID_TRANSITION"
  | "COMMAND_ID_CONFLICT"
  | "COMMAND_IN_PROGRESS"
  | "COMPOSITION_INVALID"
  | "DEFINITION_NOT_COMPILED"
  | "ACTIVITY_NOT_ACTIVE"
  | "CROSS_ACTIVITY"
  | "CAPABILITY_NOT_ENABLED"
  | "CAPABILITY_VERSION_MISMATCH"
  | "RUNTIME_CONTRACT_MISMATCH"
  | "SCOPE_UNDECLARED"
  | "RELEASE_SNAPSHOT_INCOMPLETE"
  | "DEFINITION_HASH_MISMATCH"
  | "VERSION_NOT_RELEASED"
  | "SESSION_NOT_RUNNING"
  | "SCOPE_ALREADY_RUNNING"
  | "SCOPE_CONFLICT"
  | "TEST_FORMAL_CONFLICT"
  | "ACTIVITY_HAS_RUNNING_SESSIONS"
  | "ROUND_UNKNOWN"
  | "ROUND_ALREADY_PREPARED"
  | "ROUND_NOT_PREPARED"
  | "ROUND_LOCKED"
  | "PANEL_ALREADY_ACTIVE"
  | "PANEL_NOT_ACTIVE"
  | "PERFORMANCE_ALREADY_OPEN"
  | "PERFORMANCE_NOT_OPEN"
  | "PERFORMANCE_LOCKED"
  | "PERFORMANCE_SCORE_OPEN"
  | "SCORE_GATE_OPEN"
  | "NO_PERFORMANCES"
  | "JUDGE_ROSTER_INVALID"
  | "DUPLICATE_SCORE_FACT"
  | "STALE_CONTEXT"
  | "PERFORMANCE_NOT_SCORABLE"
  | "SOURCE_REFERENCE_REQUIRED"
  | "CORRECTION_REQUIRED"
  | "SCORE_FACT_LOCKED"
  | "SCORE_FACT_NOT_FOUND"
  | "CORRECTION_NOT_FOUND"
  | "CORRECTION_ALREADY_OPEN";

/**
 * A refusal the caller can act on. Domain code and human message travel
 * together so a UI or an HTTP layer never has to invent either one.
 */
export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

export function fail(code: DomainErrorCode, message: string): never {
  throw new DomainError(code, message);
}
