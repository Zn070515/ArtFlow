import { randomUUID } from "node:crypto";

import { closeDb, createDb, insertLocalAccount, migrate } from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import { hashPassword } from "@artflow-plus/runtime";
import type { RuntimeDeps } from "@artflow-plus/runtime";
import type { FastifyInstance } from "fastify";
import { Client } from "pg";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_api_read_surface_${Date.now()}_${process.pid}`;

let app: FastifyInstance;
let db: Kysely<Database>;
let admin: Client;

const deps: RuntimeDeps = {
  now: () => new Date().toISOString(),
  newEventId: () => randomUUID(),
};

/**
 * The internal read plane is a contract, not a per-handler afterthought. Every
 * route that can see activity internals must refuse an anonymous caller, and a
 * signed-in participant with no operational permission must not see rankings,
 * executions, vote tallies, or event feeds before publishing.
 */
const INTERNAL_READS = [
  "/api/activities",
  "/api/activities/any",
  "/api/activities/any/executions",
  "/api/activities/any/execution-state",
  "/api/activities/any/events",
  "/api/activities/any/competition/rounds/final/ranking?scope=judging",
  "/api/activities/any/voting/sessions",
  "/api/activities/any/voting/sessions/any/scores",
  "/api/activities/any/voting/sessions/any/live",
  "/api/activities/any/studio",
  "/api/activities/any/tasks",
  "/api/activities/any/readiness",
  "/api/activities/any/publishing/state",
  "/api/activities/any/archive",
] as const;

describe.skipIf(!connectionString)("internal read surface", () => {
  beforeAll(async () => {
    if (!connectionString) return;
    admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = createDb({ connectionString, schema });
    await migrate(db);
    app = await buildApp({ db, deps });
    await app.ready();
    await insertLocalAccount(db, {
      username: "read-participant",
      passwordDigest: hashPassword("participant-password"),
      actor: {
        actorId: "read-participant",
        actorType: "user",
        roles: ["participant"],
        permissions: [],
      },
      active: true,
    });
  });

  afterAll(async () => {
    if (!connectionString) return;
    await app.close();
    await closeDb(db);
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });

  it("rejects anonymous internal reads before any handler runs", async () => {
    for (const url of INTERNAL_READS) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode, `${url} must not be anonymous`).toBe(401);
    }
  });

  it("rejects a signed-in participant without an operational permission", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/token",
      headers: { "content-type": "application/json" },
      payload: { username: "read-participant", password: "participant-password" },
    });
    expect(login.statusCode).toBe(200);
    const token = login.json().token as string;
    for (const url of INTERNAL_READS) {
      const response = await app.inject({
        method: "GET",
        url,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode, `${url} must reject a participant`).toBe(403);
    }
  });

  it("keeps the explicit public selectors anonymous", async () => {
    for (const url of [
      "/healthz",
      "/api/capabilities",
      "/api/packs",
      "/api/public/activities/UNKNOWN",
      "/api/public/vote/UNKNOWN",
      "/api/public/results/UNKNOWN",
      "/api/activities/any/voting/browser-identity",
    ]) {
      const response = await app.inject({ method: "GET", url });
      expect([401, 403], `${url} must stay public`).not.toContain(response.statusCode);
    }
  });
});
