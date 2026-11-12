import { randomUUID } from "node:crypto";

import type { Database } from "@artflow-plus/db";
import { getExecutionProjection, insertAudit } from "@artflow-plus/db";
import type { ActorContext } from "@artflow-plus/domain";
import { appendEngineEvent, executeCommand, relayOutboxOnce } from "@artflow-plus/runtime";
import type { RuntimeDeps } from "@artflow-plus/runtime";
import type { Kysely } from "kysely";
import { expect } from "vitest";

import type { CommandAdapter } from "./command.js";

interface SideEffectCounts {
  readonly receipts: number;
  readonly audits: number;
  readonly events: number;
}

async function count(
  db: Kysely<Database>,
  table: "command_receipt" | "audit_entry" | "outbox",
  activityId: string,
): Promise<number> {
  const row = await db
    .selectFrom(table)
    .select((expression) => expression.fn.countAll<number>().as("count"))
    .where("activity_id", "=", activityId)
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

async function sideEffectCounts(
  db: Kysely<Database>,
  activityId: string,
): Promise<SideEffectCounts> {
  return {
    receipts: await count(db, "command_receipt", activityId),
    audits: await count(db, "audit_entry", activityId),
    events: await count(db, "outbox", activityId),
  };
}

export type RollbackPoint = "handler-start" | "after-audit" | "after-event";

/**
 * A handler that fails at any point must leave no receipt, audit, or outbox
 * row. The audit probe writes an extra audit inside the handler so the failure
 * lands after an audit statement, not only after a domain fact.
 */
export async function assertRollbackPoints(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  activityId: string,
  actor: ActorContext,
): Promise<void> {
  const before = await sideEffectCounts(db, activityId);
  for (const point of ["handler-start", "after-audit", "after-event"] as const) {
    const commandId = `contract-fault-${point}-${randomUUID()}`;
    await expect(
      executeCommand(db, {
        commandId,
        activityId,
        capability: "contract",
        commandType: "contract.fault",
        actor,
        payload: { point },
      }, async (trx) => {
        if (point === "after-audit" || point === "after-event") {
          await insertAudit(trx, {
            commandId,
            activityId,
            capability: "contract",
            commandType: "contract.fault.probe",
            actor,
            detail: { point },
          });
        }
        if (point === "after-event") {
          await appendEngineEvent(trx, deps, {
            type: "ContractFaultProbe",
            activityId,
            aggregateType: "contract",
            aggregateId: activityId,
            revision: 0,
            payload: { point },
          });
        }
        throw new Error(`contract fault at ${point}`);
      }),
      `the ${point} fault must surface`,
    ).rejects.toThrow(`contract fault at ${point}`);
    expect(
      await sideEffectCounts(db, activityId),
      `the ${point} fault must roll back every side effect`,
    ).toEqual(before);
  }
}

/**
 * Two callers submit the same command id at the same time. Exactly one handler
 * runs; the other either replays the committed receipt or blocks until it can.
 * The durable side effects must still be one receipt, one audit, one event.
 */
export async function assertConcurrentCommand<T>(
  adapter: CommandAdapter<T>,
): Promise<void> {
  const commandId = `${adapter.name}-concurrent-${randomUUID()}`;
  const before = await adapter.eventCount();
  const outcomes = await Promise.all([
    adapter.execute({ commandId }),
    adapter.execute({ commandId }),
  ]);
  expect(
    outcomes.filter((outcome) => outcome.replayed),
    `${adapter.name}: one concurrent caller must replay`,
  ).toHaveLength(1);
  expect(await adapter.countReceipts(commandId), `${adapter.name}: one receipt`).toBe(1);
  expect(await adapter.countAudits(commandId), `${adapter.name}: one audit`).toBe(1);
  expect(await adapter.eventCount(), `${adapter.name}: one event`).toBe(before + 1);
}

/**
 * Event delivery is at-least-once: a relay pass that runs twice over the same
 * batch must not advance the projection or duplicate a session.
 */
export async function assertRelayIdempotence(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  activityId: string,
): Promise<void> {
  const sessionId = `contract-session-${randomUUID()}`;
  await db.transaction().execute(async (trx) => {
    await appendEngineEvent(trx, deps, {
      type: "ExecutionSessionStarted",
      activityId,
      aggregateType: "execution_session",
      aggregateId: sessionId,
      revision: 0,
      capability: "engine",
      mode: "rehearsal",
      scope: "contract",
      payload: {
        sessionId,
        scope: "contract",
        mode: "rehearsal",
        definitionVersion: 1,
        contentHash: "contract-fault-probe",
        openedAt: deps.now(),
      },
    });
  });

  const first = await relayOutboxOnce(db);
  expect(first.failed, "the first relay pass must not fail an event").toBe(0);
  const afterFirst = await getExecutionProjection(db, activityId, "rehearsal");
  expect(afterFirst, "the relay must project the session").not.toBeNull();
  expect(afterFirst?.state.sessions[sessionId]).toBeDefined();

  const second = await relayOutboxOnce(db);
  expect(second.failed, "the duplicate relay pass must not fail").toBe(0);
  expect(second.claimed, "the duplicate relay pass has nothing to claim").toBe(0);
  expect(
    await getExecutionProjection(db, activityId, "rehearsal"),
    "a duplicate pass must not advance or duplicate the projection",
  ).toEqual(afterFirst);
}
