import type { Database, SessionRecord, StoredRelease } from "@artflow-plus/db";
import { findRunningSessionByScope, getRelease } from "@artflow-plus/db";
import { DomainError, type ExecutionPolicy } from "@artflow-plus/domain";
import type { Kysely } from "kysely";

/**
 * A release freezes which scope each command may run in. A handler must never
 * accept any declared scope the caller names: that let a voting command borrow
 * a running "judging" session after its own voting session closed.
 */
export function requireCommandScope(
  policy: ExecutionPolicy,
  commandType: string,
  scope: string,
): void {
  const allowed = policy.commandScopes?.[commandType];
  if (allowed === undefined || allowed.length === 0) {
    throw new DomainError(
      "COMMAND_SCOPE_UNDECLARED",
      `The release does not bind command ${commandType} to an execution scope.`,
    );
  }
  if (!allowed.includes(scope)) {
    throw new DomainError(
      "SCOPE_NOT_AUTHORIZED",
      `Command ${commandType} may not run in scope ${scope}.`,
    );
  }
}

export interface RunningCommandSession {
  readonly release: StoredRelease;
  readonly session: SessionRecord;
}

/**
 * Resolves the session for a command from the frozen release policy. The caller
 * supplies the scope only so it can be checked; it is never trusted as
 * ownership of that scope.
 */
export async function requireRunningCommandSession(
  trx: Kysely<Database>,
  activity: { readonly id: string },
  commandType: string,
  scope: string,
): Promise<RunningCommandSession> {
  const session = await findRunningSessionByScope(trx, activity.id, scope);
  if (session === null) {
    throw new DomainError("SESSION_NOT_RUNNING", `Scope ${scope} has no running execution session.`);
  }
  // Read the policy frozen with the session's own release, not the activity's
  // current release: an in-flight formal session keeps its semantics.
  const release = await getRelease(trx, activity.id, session.definitionVersion);
  if (release === null) {
    throw new DomainError("VERSION_NOT_RELEASED", "The session's definition release is no longer available.");
  }
  requireCommandScope(release.executionPolicy, commandType, scope);
  return { release, session };
}
