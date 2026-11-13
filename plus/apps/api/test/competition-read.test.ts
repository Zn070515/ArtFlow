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
import { seedCompetitionReadFixture } from "./helpers/competition-read-fixture.js";
import type { CompetitionReadFixture } from "./helpers/competition-read-fixture.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_api_competition_read_${Date.now()}_${process.pid}`;
const dbIt = connectionString ? it : it.skip;

let app: FastifyInstance;
let db: Kysely<Database>;
let admin: Client;
let fixture: CompetitionReadFixture;

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
  const accounts = [
    { username: "competition-reader", password: "reader-password", actorId: "competition-reader", permissions: ["competition.manage"] },
    { username: "judge-only", password: "judge-password", actorId: "judge-only", permissions: ["judge.manage"] },
    { username: "score-writer", password: "writer-password", actorId: "score-writer", permissions: ["competition.score.write"] },
  ] as const;
  for (const account of accounts) {
    await insertLocalAccount(db, {
      username: account.username,
      passwordDigest: hashPassword(account.password),
      actor: {
        actorId: account.actorId,
        actorType: "user",
        roles: ["staff"],
        permissions: [...account.permissions],
      },
      active: true,
    });
  }
  fixture = await seedCompetitionReadFixture(db);
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

async function bearer(username: string, password: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/token",
    headers: { "content-type": "application/json" },
    payload: { username, password },
  });
  expect(response.statusCode).toBe(200);
  return response.json().token as string;
}

function scoresUrl(): string {
  return `/api/activities/${fixture.activityId}/competition/rounds/final/scores?scope=judging`;
}

dbIt("returns the round score projection to competition readers", async () => {
  const token = await bearer("competition-reader", "reader-password");
  const response = await app.inject({
    method: "GET",
    url: scoresUrl(),
    headers: { authorization: `Bearer ${token}` },
  });
  expect(response.statusCode).toBe(200);
  const body = response.json();
  expect(body.facts).toHaveLength(3);
  expect(body.session).toMatchObject({ mode: "formal", scope: "judging" });
  expect(body.round).toMatchObject({ key: "final", state: "locked", advanceCount: 1 });
});

dbIt("allows a score writer to read the projection", async () => {
  const token = await bearer("score-writer", "writer-password");
  const response = await app.inject({
    method: "GET",
    url: scoresUrl(),
    headers: { authorization: `Bearer ${token}` },
  });
  expect(response.statusCode).toBe(200);
  expect(response.json().facts).toHaveLength(3);
});

dbIt("rejects judge-only readers", async () => {
  const token = await bearer("judge-only", "judge-password");
  const response = await app.inject({
    method: "GET",
    url: scoresUrl(),
    headers: { authorization: `Bearer ${token}` },
  });
  expect(response.statusCode).toBe(403);
});

dbIt("rejects anonymous readers", async () => {
  const response = await app.inject({ method: "GET", url: scoresUrl() });
  expect(response.statusCode).toBe(401);
});
