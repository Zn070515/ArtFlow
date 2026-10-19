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
): Promise<CommandOutcome<T>> {
  const payloadHash = stableHash({
    commandType: meta.commandType,
    activityId: meta.activityId,
    capability: meta.capability,
    scope: meta.scope ?? null,
    actorId: meta.actor.actorId,
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
      return {
        body: claim.result as T,
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
    await completeCommand(trx, meta.commandId, result.body, status);
    return { body: result.body, status, replayed: false };
  });
}
