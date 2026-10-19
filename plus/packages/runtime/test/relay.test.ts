import { randomUUID } from "node:crypto";

import type { Kysely } from "kysely";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  appendEvent,
  closeDb,
  createDb,
  getExecutionProjection,
  migrate,
} from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import {
  competitionCapability,
  createCapabilityRegistry,
} from "@artflow-plus/domain";
import type { CapabilityRegistry } from "@artflow-plus/domain";

import {
  createActivity,
  getExecutionState,
  relayOutboxOnce,
  retryBlockedProjection,
} from "../src/index.js";
import type { RuntimeDeps } from "../src/index.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_relay_${Date.now()}_${process.pid}`;

let db: Kysely<Database>;
let admin: Client;
let registry: CapabilityRegistry;
let deps: RuntimeDeps;

function eventPayload(sessionId: string, scope: string) {
  return {
    sessionId,
    definitionVersion: 1,
    contentHash: "hash",
    scope,
    mode: "formal",
    openedAt: "2026-10-19T10:00:00Z",
  };
}

describe.skipIf(!connectionString)("outbox relay partitioning", () => {
  beforeAll(async () => {
    if (!connectionString) return;
    admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = createDb({ connectionString, schema });
    await migrate(db);
    const created = createCapabilityRegistry([competitionCapability]);
    if (!created.ok) throw new Error(JSON.stringify(created.issues));
    registry = created.registry;
    deps = {
      now: () => "2026-10-19T10:00:00Z",
      newEventId: () => randomUUID(),
    };
  });

  afterAll(async () => {
    if (!connectionString) return;
    await closeDb(db);
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });

  it("blocks a partition on a dead letter instead of skipping it", async () => {
    const activity = await createActivity(db, registry, deps, {
      commandId: `create-${randomUUID()}`,
      title: "Relay block",
      capabilities: ["competition"],
    });
    const activityId = activity.body.id;

    const badStart = await db.transaction().execute((trx) =>
      appendEvent(trx, {
        eventId: `evt-${randomUUID()}`,
        type: "ExecutionSessionStarted",
        occurredAt: "2026-10-19T10:00:00Z",
        activityId,
        aggregateType: "execution_session",
        aggregateId: "session-bad",
        capability: "engine",
        revision: 0,
        mode: "formal",
        scope: "stage",
        payload: {},
      }),
    );
    const goodStart = await db.transaction().execute((trx) =>
      appendEvent(trx, {
        eventId: `evt-${randomUUID()}`,
        type: "ExecutionSessionStarted",
        occurredAt: "2026-10-19T10:00:01Z",
        activityId,
        aggregateType: "execution_session",
        aggregateId: "session-good",
        capability: "engine",
        revision: 0,
        mode: "formal",
        scope: "checkin",
        payload: eventPayload("session-good", "checkin"),
      }),
    );
    const goodClose = await db.transaction().execute((trx) =>
      appendEvent(trx, {
        eventId: `evt-${randomUUID()}`,
        type: "ExecutionSessionClosed",
        occurredAt: "2026-10-19T10:00:02Z",
        activityId,
        aggregateType: "execution_session",
        aggregateId: "session-good",
        capability: "engine",
        revision: 1,
        mode: "formal",
        scope: "checkin",
        payload: {
          sessionId: "session-good",
          closedAt: "2026-10-19T10:00:02Z",
          revision: 1,
        },
      }),
    );

    const firstPass = await relayOutboxOnce(db, { maxAttempts: 1 });
    expect(firstPass.failed).toBe(1);
    expect(firstPass.blockedPartitions).toBeGreaterThanOrEqual(1);

    const blocked = await getExecutionProjection(db, activityId, "formal");
    expect(blocked).toMatchObject({
      status: "blocked",
      blockedSequence: badStart,
    });

    const pending = await db
      .selectFrom("outbox")
      .selectAll()
      .where("id", "in", [String(goodStart), String(goodClose)])
      .execute();
    expect(pending.every((row) => row.published_at === null)).toBe(true);

    const secondPass = await relayOutboxOnce(db, { maxAttempts: 1 });
    expect(secondPass.claimed).toBe(0);
    expect(secondPass.blockedPartitions).toBeGreaterThanOrEqual(1);

    // Repair the bad event, then explicitly retry the blocked partition.
    await db
      .updateTable("outbox")
      .set({ payload: JSON.stringify(eventPayload("session-bad", "stage")) })
      .where("id", "=", String(badStart))
      .execute();
    expect(await retryBlockedProjection(db, activityId, "formal")).toBe(true);

    const resumed = await relayOutboxOnce(db, { maxAttempts: 1 });
    expect(resumed.failed).toBe(0);

    const state = await getExecutionState(db, activityId, "formal");
    expect(state.status).toBe("running");
    expect(state.stale).toBe(false);
    expect(state.runningScopes).toEqual(["stage"]);
    expect(state.sessions["session-good"]?.status).toBe("closed");
    expect(state.sessions["session-bad"]?.status).toBe("running");

    const published = await db
      .selectFrom("outbox")
      .selectAll()
      .where("id", "in", [String(badStart), String(goodStart), String(goodClose)])
      .execute();
    expect(published.every((row) => row.published_at !== null)).toBe(true);
  });
});
