import { randomUUID } from "node:crypto";

import { closeDb, createDb, insertLocalAccount, migrate } from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import { hashPassword } from "@artflow-plus/runtime";
import type { RuntimeDeps } from "@artflow-plus/runtime";
import type { FastifyInstance } from "fastify";
import { Client } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Kysely } from "kysely";

import { buildApp } from "../src/app.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_api_competition_${Date.now()}_${process.pid}`;
const dbIt = connectionString ? it : it.skip;

let app: FastifyInstance;
let db: Kysely<Database>;
let admin: Client;

const deps: RuntimeDeps = {
  now: () => "2026-10-19T19:00:00.000Z",
  newEventId: () => randomUUID(),
};

beforeAll(async () => {
  if (!connectionString) return;
  admin = new Client({ connectionString });
  await admin.connect();
  await admin.query(`CREATE SCHEMA "${schema}"`);
  db = createDb({ connectionString, schema });
  await migrate(db);
  await insertLocalAccount(db, {
    username: "competition-api-staff",
    passwordDigest: hashPassword("test-password"),
    actor: {
      actorId: "api-staff",
      actorType: "user",
      roles: ["staff"],
      permissions: ["competition.manage", "competition.round.prepare"],
    },
    active: true,
  });
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

async function bearer(): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { "content-type": "application/json" },
    payload: { username: "competition-api-staff", password: "test-password" },
  });
  expect(response.statusCode).toBe(200);
  return response.json().token as string;
}

dbIt("requires bearer authentication and idempotency for M5 writes", async () => {
  const unauthenticated = await app.inject({
    method: "POST",
    url: "/api/activities/missing/competition/rounds",
    headers: { "idempotency-key": "competition-api-unauthenticated", "content-type": "application/json" },
    payload: { roundKey: "final", scope: "judging" },
  });
  expect(unauthenticated.statusCode).toBe(401);

  const token = await bearer();
  const missingIdempotency = await app.inject({
    method: "POST",
    url: "/api/activities/missing/competition/rounds",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    payload: { roundKey: "final", scope: "judging" },
  });
  expect(missingIdempotency.statusCode).toBe(400);
});

dbIt("does not accept actor or permission claims from an M5 request body", async () => {
  const token = await bearer();
  const response = await app.inject({
    method: "POST",
    url: "/api/activities/missing/competition/rounds",
    headers: {
      authorization: `Bearer ${token}`,
      "idempotency-key": "competition-api-forged-actor",
      "content-type": "application/json",
    },
    payload: {
      roundKey: "final",
      scope: "judging",
      actorId: "forged-admin",
      permissions: ["*"],
    },
  });
  expect(response.statusCode).toBe(404);
  expect(response.json().code).toBe("NOT_FOUND");
});
