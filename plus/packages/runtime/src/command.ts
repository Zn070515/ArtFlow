import type { Database } from "@artflow-plus/db";
import {
  claimCommand,
  completeCommand,
  insertAudit,
} from "@artflow-plus/db";
import type { ActorContext } from "@artflow-plus/domain";
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
  /** Derived from the authenticated session by the transport, never a body. */
  readonly actor: ActorContext;
}

export interface CommandOutcome<T> {
  readonly body: T;
  readonly status: number;
  readonly replayed: boolean;
}

export interface CommandHandlerResult<T> {
  readonly body: T;
  readonly status?: number;
  /**
   * Sensitive one-time response fields (ticket/session credentials) must not
   * be put into the replay receipt. The first response still returns `body`,
   * while retries replay this redacted representation.
   */
  readonly persistedBody?: unknown;
}

export interface CommandExecutionOptions<T> {
  /** Rebuild sensitive fields that were intentionally redacted from the receipt. */
  readonly onReplay?: (trx: Transaction<Database>, result: T) => Promise<T> | T;
}

/**
 * The single write path (AUTH-01). The receipt, the audit entry, the fact and
 * every outbox event live in one transaction; a retry with the same command id
 * and payload replays the stored response **before** any domain, registry or
 * compiler validation runs.
 */
export async function executeCommand<T>(
  db: Kysely<Database>,
  meta: CommandMeta,
  handler: (trx: Transaction<Database>) => Promise<CommandHandlerResult<T>>,
  options: CommandExecutionOptions<T> = {},
): Promise<CommandOutcome<T>> {
  // The actor is checked against the stored receipt in claimCommand, not
  // hashed here: keeping the hash format stable lets receipts written before
  // actors existed still replay after an upgrade.
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
      actor: meta.actor,
    });
    if (claim.kind === "replay") {
      const body = claim.result as T;
      return {
        body: options.onReplay === undefined ? body : await options.onReplay(trx, body),
        status: claim.httpStatus,
        replayed: true,
      };
    }

    const result = await handler(trx);
    const status = result.status ?? 200;
    await insertAudit(trx, {
      commandId: meta.commandId,
      activityId: meta.activityId,
      capability: meta.capability,
      commandType: meta.commandType,
      actor: meta.actor,
      detail: {
        status,
        scope: meta.scope ?? null,
        payloadHash,
      },
    });
    await completeCommand(trx, meta.commandId, result.persistedBody ?? result.body, status);
    return { body: result.body, status, replayed: false };
  });
}
