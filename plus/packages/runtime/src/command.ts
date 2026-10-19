import type { Database } from "@artflow-plus/db";
import { claimCommand, completeCommand } from "@artflow-plus/db";
import type { Kysely, Transaction } from "kysely";

import { stableHash } from "./hash.js";

export interface CommandMeta {
  readonly commandId: string;
  readonly activityId: string;
  readonly capability: string;
  readonly commandType: string;
  readonly scope?: string;
  /** Full command input minus the command id; hashed for conflict detection. */
  readonly payload: unknown;
}

export interface CommandOutcome<T> {
  readonly body: T;
  readonly status: number;
  readonly replayed: boolean;
}

export interface CommandHandlerResult<T> {
  readonly body: T;
  readonly status?: number;
}

/**
 * The single write path (AUTH-01). The receipt, the fact and every outbox
 * event live in one transaction; a retry with the same command id replays the
 * stored response, and a retry with a different payload is refused.
 */
export async function executeCommand<T>(
  db: Kysely<Database>,
  meta: CommandMeta,
  handler: (trx: Transaction<Database>) => Promise<CommandHandlerResult<T>>,
): Promise<CommandOutcome<T>> {
  const payloadHash = stableHash({
    commandType: meta.commandType,
    activityId: meta.activityId,
    capability: meta.capability,
    scope: meta.scope ?? null,
    payload: meta.payload,
  });

  return db.transaction().execute(async (trx) => {
    const claim = await claimCommand(trx, {
      commandId: meta.commandId,
      activityId: meta.activityId,
      capability: meta.capability,
      commandType: meta.commandType,
      payloadHash,
      scope: meta.scope ?? null,
    });
    if (claim.kind === "replay") {
      return {
        body: claim.result as T,
        status: claim.httpStatus,
        replayed: true,
      };
    }

    const result = await handler(trx);
    const status = result.status ?? 200;
    await completeCommand(trx, meta.commandId, result.body, status);
    return { body: result.body, status, replayed: false };
  });
}
