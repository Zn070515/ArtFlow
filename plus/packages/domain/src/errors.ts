export type DomainErrorCode =
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "STALE_REVISION"
  | "INVALID_TRANSITION"
  | "DEFINITION_NOT_COMPILED"
  | "ACTIVITY_NOT_ACTIVE"
  | "CROSS_ACTIVITY"
  | "CAPABILITY_NOT_ENABLED"
  | "DEFINITION_HASH_MISMATCH"
  | "VERSION_NOT_RELEASED"
  | "SCOPE_ALREADY_RUNNING"
  | "SCOPE_CONFLICT"
  | "TEST_FORMAL_CONFLICT"
  | "ACTIVITY_HAS_RUNNING_SESSIONS";

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
