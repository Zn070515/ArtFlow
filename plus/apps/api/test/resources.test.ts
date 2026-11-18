import { randomUUID } from "node:crypto";

import { closeDb, createDb, insertLocalAccount, insertRelease, migrate } from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import { compileResourcesDefinition, createResourcesDefinition } from "@artflow-plus/domain";
import { hashPassword, MemoryRateLimiter } from "@artflow-plus/runtime";
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
const schema = `artflow_api_resources_${Date.now()}_${process.pid}`;

let db: Kysely<Database>;
let admin: Client;
let app: FastifyInstance;
let token = "";
const activityId = "resources-api-activity";

const deps: RuntimeDeps = {
  now: () => new Date().toISOString(),
  newEventId: () => randomUUID(),
};

async function command(
  method: "POST" | "PUT",
  url: string,
  payload: Record<string, unknown>,
): Promise<{ readonly statusCode: number; readonly json: () => any }> {
  return await app.inject({
    method,
    url,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      "idempotency-key": randomUUID(),
    },
    payload,
  }) as unknown as { statusCode: number; json: () => any };
}

describe.skipIf(!connectionString)("resources API", () => {
  beforeAll(async () => {
    if (!connectionString) return;
    admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = createDb({ connectionString, schema });
    await migrate(db);
    app = await buildApp({ db, deps, rateLimiter: new MemoryRateLimiter() });
    await app.ready();
    await insertLocalAccount(db, {
      username: "resources-api",
      passwordDigest: hashPassword("resources-api-password"),
      actor: {
        actorId: "resources-api",
        actorType: "user",
        roles: ["staff"],
        permissions: ["resources.manage"],
      },
      active: true,
    });
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/token",
      headers: { "content-type": "application/json" },
      payload: { username: "resources-api", password: "resources-api-password" },
    });
    token = login.json().token as string;

    const artifact = compileResourcesDefinition(createResourcesDefinition([
      { key: "hall", name: "主礼堂", kind: "venue", capacity: 800, notes: "" },
    ]));
    if (!artifact.ok) throw new Error(JSON.stringify(artifact));
    await db.insertInto("activity").values({
      id: activityId,
      public_code: "RES-API",
      title: "Resources API",
      status: "active",
      revision: 1,
      enabled_capabilities: JSON.stringify(["resources"]),
      active_definition_version: 1,
    }).execute();
    await insertRelease(db, {
      activityId,
      version: 1,
      contentHash: "resources-api-release",
      capabilities: { resources: artifact },
      executionPolicy: {
        declaredScopes: [],
        conflicts: {},
        runtimeContractVersion: 2,
        commandScopes: {},
      },
      capabilityVersions: { resources: "1.0.0" },
      bindings: [],
      releasedAt: "2026-11-18T09:00:00Z",
      sourceDraftRevision: 1,
    });
  });

  afterAll(async () => {
    if (!connectionString) return;
    await app.close();
    await closeDb(db);
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });

  it("creates, confirms and rejects a conflicting booking", async () => {
    const first = await command("POST", `/api/activities/${activityId}/resources/bookings`, {
      resourceKey: "hall",
      title: "彩排 A",
      startsAt: "2026-11-20T10:00:00.000Z",
      endsAt: "2026-11-20T12:00:00.000Z",
    });
    expect(first.statusCode).toBe(201);
    const firstBooking = first.json() as { id: string; revision: number };
    const confirmed = await command("POST", `/api/activities/${activityId}/resources/bookings/${firstBooking.id}/confirm`, {
      expectedRevision: firstBooking.revision,
    });
    expect(confirmed.statusCode).toBe(200);

    const second = await command("POST", `/api/activities/${activityId}/resources/bookings`, {
      resourceKey: "hall",
      title: "彩排 B",
      startsAt: "2026-11-20T11:00:00.000Z",
      endsAt: "2026-11-20T13:00:00.000Z",
    });
    const secondBooking = second.json() as { id: string; revision: number };
    const conflict = await command("POST", `/api/activities/${activityId}/resources/bookings/${secondBooking.id}/confirm`, {
      expectedRevision: secondBooking.revision,
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().code).toBe("RESOURCE_CONFLICT");

    const view = await app.inject({
      method: "GET",
      url: `/api/activities/${activityId}/resources`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(view.statusCode).toBe(200);
    expect(view.json().resources).toEqual([
      expect.objectContaining({ key: "hall", kind: "venue" }),
    ]);
    expect(view.json().bookings).toHaveLength(2);
  });
});
