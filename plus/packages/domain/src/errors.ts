export type DomainErrorCode =
  | "INVALID_INPUT"
  | "STALE_REVISION"
  | "INVALID_TRANSITION"
  | "ACTIVITY_NOT_ACTIVE"
  | "CROSS_ACTIVITY"
  | "DEFINITION_HASH_MISMATCH"
  | "VERSION_NOT_RELEASED"
  | "RUN_ALREADY_ACTIVE";

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
