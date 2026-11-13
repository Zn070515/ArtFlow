import { ApiError } from "../../api/client.js";

/**
 * Shared operator-facing error text. A 409 usually means another operator won
 * the race, so each surface supplies its own recovery sentence instead of
 * repeating the mapping.
 */
export function apiErrorText(
  error: unknown,
  fallback: string,
  conflictMessage: string,
): string {
  if (error instanceof ApiError && error.status === 409) return conflictMessage;
  return error instanceof Error ? error.message : fallback;
}
