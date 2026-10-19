import type { Kysely } from "kysely";

import type { Database } from "./types.js";

export interface CommandClaimInput {
  readonly commandId: string;
  readonly activityId: string;
  readonly capability: string;
  readonly commandType: string;
  readonly payloadHash: string;
  readonly scope: string | null;
}

export type CommandClaim =
  | { readonly kind: "claimed" }
  | { readonly kind: "replay"; readonly result: unknown; readonly httpStatus: number };

/** Same command id, different request: never execute or silently reuse. */
export class CommandIdConflictError extends Error {
  readonly code = "COMMAND_ID_CONFLICT";

  constructor(commandId: string) {
    super(`Command ${commandId} was already used with different input.`);
    this.name = "CommandIdConflictError";
  }
}

export class CommandInProgressError extends Error {
  readonly code = "COMMAND_IN_PROGRESS";

  constructor(commandId: string) {
    super(`Command ${commandId} is still in progress.`);
    this.name = "CommandInProgressError";
  }
}

/**
 * Claims a command id inside the command transaction. The insert-first pattern
 * serializes duplicate retries: the second caller blocks on the unique index,
 * then replays the committed result (CONC-04).
 */
export async function claimCommand(
  trx: Kysely<Database>,
  input: CommandClaimInput,
): Promise<CommandClaim> {
  const inserted = await trx
    .insertInto("command_receipt")
    .values({
      command_id: input.commandId,
      activity_id: input.activityId,
      capability: input.capability,
      command_type: input.commandType,
      payload_hash: input.payloadHash,
      scope: input.scope,
      result: null,
      http_status: null,
    })
    .onConflict((conflict) => conflict.column("command_id").doNothing())
    .returningAll()
    .executeTakeFirst();

  if (inserted !== undefined) return { kind: "claimed" };

  const existing = await trx
    .selectFrom("command_receipt")
    .selectAll()
    .where("command_id", "=", input.commandId)
    .forUpdate()
    .executeTakeFirst();
  if (existing === undefined) {
    throw new Error(`Command ${input.commandId} lost its receipt.`);
  }
  if (existing.payload_hash !== input.payloadHash) {
    throw new CommandIdConflictError(input.commandId);
  }
  if (existing.result === null) {
    throw new CommandInProgressError(input.commandId);
  }
  return {
    kind: "replay",
    result: existing.result,
    httpStatus: existing.http_status ?? 200,
  };
}

export async function completeCommand(
  trx: Kysely<Database>,
  commandId: string,
  result: unknown,
  httpStatus: number,
): Promise<void> {
  await trx
    .updateTable("command_receipt")
    .set({
      result: JSON.stringify(result),
      http_status: httpStatus,
    })
    .where("command_id", "=", commandId)
    .execute();
}
