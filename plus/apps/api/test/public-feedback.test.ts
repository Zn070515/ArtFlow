import { randomUUID } from "node:crypto";

import { closeDb, createDb, migrate } from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import type { RuntimeDeps } from "@artflow-plus/runtime";
import type { FastifyInstance } from "fastify";
import { Client } from "pg";
import { sql, type Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_api_feedback_${Date.now()}_${process.pid}`;

let app: FastifyInstance;
let db: Kysely<Database>;
let admin: Client;

const deps: RuntimeDeps = {
  now: () => new Date().toISOString(),
  newEventId: () => randomUUID(),
};

async function seed(status: "active" | "closed"): Promise<string> {
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
  return publicCode;
}

async function countFeedback(publicCode: string): Promise<number> {
  const activity = await db.selectFrom("activity").select("id")
    .where("public_code", "=", publicCode).executeTakeFirstOrThrow();
  const row = await db.selectFrom("activity_feedback")
    .select(sql<number>`count(*)::int`.as("count"))
    .where("activity_id", "=", activity.id)
    .executeTakeFirstOrThrow();
  return row.count;
}

describe.skipIf(!connectionString)("public feedback", () => {
  beforeAll(async () => {
    if (!connectionString) return;
    admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = createDb({ connectionString, schema });
    await migrate(db);
    app = await buildApp({ db, deps });
    await app.ready();
  });

  afterAll(async () => {
    if (!connectionString) return;
    await app.close();
    await closeDb(db);
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });

  it("accepts feedback after closing, replays, and ignores the honeypot", async () => {
    const publicCode = await seed("closed");
    const response = await app.inject({
      method: "POST",
      url: `/api/public/activities/${publicCode}/feedback`,
      headers: { "idempotency-key": "feedback-1" },
      payload: { rating: 5, comment: "流程很顺" },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ status: "submitted" });
    expect(await countFeedback(publicCode)).toBe(1);

    const replay = await app.inject({
      method: "POST",
      url: `/api/public/activities/${publicCode}/feedback`,
      headers: { "idempotency-key": "feedback-1" },
      payload: { rating: 5, comment: "流程很顺" },
    });
    expect(replay.statusCode).toBe(201);
    expect(await countFeedback(publicCode)).toBe(1);

    const honeypot = await app.inject({
      method: "POST",
      url: `/api/public/activities/${publicCode}/feedback`,
      headers: { "idempotency-key": "feedback-honeypot" },
      payload: { rating: 1, comment: "bot", website: "https://spam.example" },
    });
    expect(honeypot.statusCode).toBe(201);
    expect(await countFeedback(publicCode)).toBe(1);
  });

  it("rejects feedback while active and invalid ratings", async () => {
    const active = await seed("active");
    const early = await app.inject({
      method: "POST",
      url: `/api/public/activities/${active}/feedback`,
      headers: { "idempotency-key": "feedback-early" },
      payload: { rating: 5, comment: "" },
    });
    expect(early.statusCode).toBe(409);
    expect(early.json()).toMatchObject({ code: "INVALID_TRANSITION" });

    const closed = await seed("closed");
    const invalid = await app.inject({
      method: "POST",
      url: `/api/public/activities/${closed}/feedback`,
      headers: { "idempotency-key": "feedback-invalid" },
      payload: { rating: 0, comment: "" },
    });
    expect(invalid.statusCode).toBe(400);
  });
});
