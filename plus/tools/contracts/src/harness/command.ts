import { randomUUID } from "node:crypto";

import type { Database } from "@artflow-plus/db";
import type { ActorContext } from "@artflow-plus/domain";
import { appendEngineEvent, executeCommand } from "@artflow-plus/runtime";
import type { CommandOutcome, RuntimeDeps } from "@artflow-plus/runtime";
import type { Kysely } from "kysely";
import { expect } from "vitest";

/**
 * A command adapter exposes only what the contract needs: execute a command,
 * and count the durable side effects the single write path promises.
 */
export interface CommandAdapter<T> {
  readonly name: string;
  readonly activityId: string;
  readonly actor: ActorContext;
  readonly commandType: string;
  readonly capability: string;
  execute(input: {
    readonly commandId: string;
    readonly actor?: ActorContext;
    readonly payload?: unknown;
  }): Promise<CommandOutcome<T>>;
  countReceipts(commandId: string): Promise<number>;
  countAudits(commandId: string): Promise<number>;
  eventCount(): Promise<number>;
}

async function count(
  db: Kysely<Database>,
  table: "command_receipt" | "audit_entry" | "outbox",
  where: (query: any) => any,
): Promise<number> {
  const row = await where(
    db.selectFrom(table).select((expression) => expression.fn.countAll<number>().as("count")),
  ).executeTakeFirstOrThrow() as { readonly count: number | string };
  return Number(row.count);
}

export interface CommandCounters {
  countReceipts(commandId: string): Promise<number>;
  countAudits(commandId: string): Promise<number>;
  eventCount(): Promise<number>;
}

/**
 * The three durable counters every command adapter exposes. `activityId` is a
 * getter because adapters create their activity in setup().
 */
export function commandCounters(
  db: Kysely<Database>,
  activityId: () => string,
): CommandCounters {
  return {
    async countReceipts(commandId) {
      return count(db, "command_receipt", (query) =>
        query.where("command_id", "=", commandId));
    },
    async countAudits(commandId) {
      return count(db, "audit_entry", (query) =>
        query.where("command_id", "=", commandId));
    },
    async eventCount() {
      return count(db, "outbox", (query) =>
        query.where("activity_id", "=", activityId()));
    },
  };
}

export async function assertReplay<T>(adapter: CommandAdapter<T>): Promise<{
  readonly commandId: string;
  readonly first: CommandOutcome<T>;
  readonly replay: CommandOutcome<T>;
}> {
  const commandId = `${adapter.name}-replay-${randomUUID()}`;
  const first = await adapter.execute({ commandId });
  const replay = await adapter.execute({ commandId });
  expect(replay.replayed, `${adapter.name}: retry must replay`).toBe(true);
  expect(await adapter.countReceipts(commandId), `${adapter.name}: one receipt`).toBe(1);
  expect(await adapter.countAudits(commandId), `${adapter.name}: one audit`).toBe(1);
  return { commandId, first, replay };
}

export async function assertConflict<T>(
  adapter: CommandAdapter<T>,
  alternatePayload: unknown,
): Promise<void> {
  const commandId = `${adapter.name}-conflict-${randomUUID()}`;
  await adapter.execute({ commandId });
  await expect(
    adapter.execute({ commandId, payload: alternatePayload }),
    `${adapter.name}: same id with different payload must conflict`,
  ).rejects.toMatchObject({ code: "COMMAND_ID_CONFLICT" });
  expect(await adapter.countReceipts(commandId), `${adapter.name}: one receipt`).toBe(1);
}

export async function assertActorBinding<T>(
  adapter: CommandAdapter<T>,
  otherActor: ActorContext,
): Promise<void> {
  const commandId = `${adapter.name}-actor-${randomUUID()}`;
  await adapter.execute({ commandId });
  await expect(
    adapter.execute({ commandId, actor: otherActor }),
    `${adapter.name}: the command id belongs to the first actor`,
  ).rejects.toMatchObject({ code: "COMMAND_ID_CONFLICT" });
}

export async function assertAuthorization<T>(
  adapter: CommandAdapter<T>,
  unauthorizedActor: ActorContext,
): Promise<void> {
  const commandId = `${adapter.name}-forbidden-${randomUUID()}`;
  await expect(
    adapter.execute({ commandId, actor: unauthorizedActor }),
    `${adapter.name}: unauthorized actor must fail closed`,
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  expect(await adapter.countReceipts(commandId), `${adapter.name}: no receipt on denial`).toBe(0);
}

export async function assertAtomicSuccess<T>(adapter: CommandAdapter<T>): Promise<void> {
  const commandId = `${adapter.name}-atomic-${randomUUID()}`;
  const before = await adapter.eventCount();
  const outcome = await adapter.execute({ commandId });
  expect(outcome.replayed, `${adapter.name}: first execution is not a replay`).toBe(false);
  expect(await adapter.countReceipts(commandId), `${adapter.name}: receipt committed`).toBe(1);
  expect(await adapter.countAudits(commandId), `${adapter.name}: audit committed`).toBe(1);
  expect(await adapter.eventCount(), `${adapter.name}: event committed`).toBe(before + 1);
}

/**
 * A handler that appends an event and then throws must leave no receipt,
 * audit, or outbox row behind. This is the transaction contract, not a
 * capability-specific rule.
 */
export async function assertRollback(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  activityId: string,
  actor: ActorContext,
): Promise<void> {
  const commandId = `contract-rollback-${randomUUID()}`;
  const before = {
    receipts: await count(db, "command_receipt", (query) => query.where("activity_id", "=", activityId)),
    audits: await count(db, "audit_entry", (query) => query.where("activity_id", "=", activityId)),
    events: await count(db, "outbox", (query) => query.where("activity_id", "=", activityId)),
  };
  await expect(
    executeCommand(db, {
      commandId,
      activityId,
      capability: "contract",
      commandType: "contract.rollback",
      actor,
      payload: {},
    }, async (trx) => {
      await appendEngineEvent(trx, deps, {
        type: "ContractRollbackProbe",
        activityId,
        aggregateType: "contract",
        aggregateId: activityId,
        revision: 0,
        payload: {},
      });
      throw new Error("contract rollback probe");
    }),
    "contract rollback probe must surface",
  ).rejects.toThrow("contract rollback probe");
  expect({
    receipts: await count(db, "command_receipt", (query) => query.where("activity_id", "=", activityId)),
    audits: await count(db, "audit_entry", (query) => query.where("activity_id", "=", activityId)),
    events: await count(db, "outbox", (query) => query.where("activity_id", "=", activityId)),
  }).toEqual(before);
}
