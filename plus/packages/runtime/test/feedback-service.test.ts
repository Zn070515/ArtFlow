import { randomUUID } from "node:crypto";

import { Client } from "pg";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDb, createDb, migrate } from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import type { ActorContext } from "@artflow-plus/domain";

import type { RuntimeDeps } from "../src/deps.js";
import { getActivityFeedback, submitActivityFeedback } from "../src/feedback-service.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_feedback_${Date.now()}_${process.pid}`;

let db: Kysely<Database>;
let admin: Client;
let tick = 0;

const staff: ActorContext = {
  actorId: "feedback-staff",
  actorType: "user",
  roles: ["staff"],
  permissions: [],
};

function deps(): RuntimeDeps {
  return {
    actor: staff,
    now: () => new Date(Date.UTC(2026, 3, 1, 10, 0, tick++)).toISOString(),
    newEventId: () => `feedback-${randomUUID()}`,
  };
}

async function seed(status: "active" | "closed" | "archived") {
  const id = `act-${randomUUID()}`;
  const publicCode = `FEEDBACK-${randomUUID()}`;
  await db.insertInto("activity").values({
    id,
    public_code: publicCode,
    title: "反馈活动",
    status,
    revision: 1,
    enabled_capabilities: JSON.stringify([]),
    active_definition_version: 1,
  }).execute();
  return { id, publicCode };
}

describe.skipIf(!connectionString)("activity.feedback.submit", () => {
  beforeAll(async () => {
    if (!connectionString) return;
    admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = createDb({ connectionString, schema });
    await migrate(db);
  });

  afterAll(async () => {
    if (!connectionString) return;
    await closeDb(db);
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });

  it("submits once, replays, and summarizes", async () => {
    const activity = await seed("closed");
    const outcome = await submitActivityFeedback(db, deps(), {
      commandId: "feedback-once",
      publicCode: activity.publicCode,
      rating: 5,
      comment: "流程很顺",
    });
    expect(outcome.status).toBe(201);
    const replay = await submitActivityFeedback(db, deps(), {
      commandId: "feedback-once",
      publicCode: activity.publicCode,
      rating: 5,
      comment: "流程很顺",
    });
    expect(replay.body).toEqual(outcome.body);

    const view = await getActivityFeedback(db, activity.id);
    expect(view.items).toHaveLength(1);
    expect(view.items[0]).toMatchObject({ rating: 5, comment: "流程很顺" });
    expect(view.summary).toEqual({ count: 1, average: 5 });
  });

  it("rejects active activities and invalid input", async () => {
    const active = await seed("active");
    await expect(submitActivityFeedback(db, deps(), {
      commandId: randomUUID(),
      publicCode: active.publicCode,
      rating: 5,
      comment: "",
    })).rejects.toMatchObject({ code: "INVALID_TRANSITION" });

    const closed = await seed("closed");
    await expect(submitActivityFeedback(db, deps(), {
      commandId: randomUUID(),
      publicCode: closed.publicCode,
      rating: 0,
      comment: "",
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(submitActivityFeedback(db, deps(), {
      commandId: randomUUID(),
      publicCode: closed.publicCode,
      rating: 4,
      comment: "x".repeat(1001),
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});
