import { randomUUID } from "node:crypto";

import { closeDb, createDb, insertDraft, insertLocalAccount, migrate } from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
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
const schema = `artflow_api_duplicate_${Date.now()}_${process.pid}`;

process.env.ARTFLOW_PLUS_AUTH_PUBLIC_LIMIT = "1000";
process.env.ARTFLOW_PLUS_AUTH_USER_LIMIT = "1000";

let db: Kysely<Database>;
let admin: Client;
let app: FastifyInstance;

const deps: RuntimeDeps = {
  now: () => new Date().toISOString(),
  newEventId: () => randomUUID(),
};

function headers(extra: Record<string, string> = {}) {
  return { "content-type": "application/json", ...extra };
}

function setCookies(response: { headers: Record<string, unknown> }): string {
  const raw = response.headers["set-cookie"];
  const values = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  return values.map((value) => String(value).split(";")[0]).join("; ");
}

async function sessionFor(username: string, password: string) {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: headers(),
    payload: { username, password },
  });
  expect(response.statusCode).toBe(200);
  return {
    cookies: setCookies(response),
    csrf: response.json().csrfToken as string,
  };
}

async function createSource(
  session: { readonly cookies: string; readonly csrf: string },
): Promise<{
  readonly id: string;
  readonly title: string;
  readonly enabledCapabilities: readonly string[];
}> {
  const response = await app.inject({
    method: "POST",
    url: "/api/activities",
    headers: headers({
      cookie: session.cookies,
      "x-csrf-token": session.csrf,
      "idempotency-key": randomUUID(),
    }),
    payload: { title: "春季赛", capabilities: ["registration"] },
  });
  expect(response.statusCode).toBe(201);
  return response.json();
}

describe.skipIf(!connectionString)("activity duplication", () => {
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
      username: "duplicate-staff",
      passwordDigest: hashPassword("staff-password"),
      actor: {
        actorId: "duplicate-staff-1",
        actorType: "user",
        roles: ["staff"],
        permissions: ["studio.manage"],
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

  it("copies the composition and draft without copying releases or facts", async () => {
    const session = await sessionFor("duplicate-staff", "staff-password");
    const source = await createSource(session);
    const marker = {
      schemaVersion: 1,
      manifest: { key: "duplicate-test", title: "Duplicate test" },
      capabilities: { registration: { schemaVersion: 1, payload: { marker: "source-draft" } } },
    } as const;
    await insertDraft(db, { activityId: source.id, revision: 0, package: marker });

    const response = await app.inject({
      method: "POST",
      url: `/api/activities/${source.id}/duplicate`,
      headers: headers({
        cookie: session.cookies,
        "x-csrf-token": session.csrf,
        "idempotency-key": randomUUID(),
      }),
      payload: { title: "春季赛副本" },
    });
    expect(response.statusCode).toBe(201);
    const copy = response.json();
    expect(copy.id).not.toBe(source.id);
    expect(copy.title).toBe("春季赛副本");
    expect(copy.enabledCapabilities).toEqual(source.enabledCapabilities);
    expect(copy.status).toBe("draft");
    expect(copy.activeDefinitionVersion).toBe(0);

    const studio = await app.inject({
      method: "GET",
      url: `/api/activities/${copy.id}/studio`,
      headers: { cookie: session.cookies },
    });
    expect(studio.statusCode).toBe(200);
    expect(studio.json().draft.package).toEqual(marker);
    expect(studio.json().releases).toEqual([]);
    expect(studio.json().sessions).toEqual([]);

    const registrations = await db
      .selectFrom("registration")
      .selectAll()
      .where("activity_id", "=", copy.id)
      .execute();
    expect(registrations).toEqual([]);
  });

  it("defaults the title to a copy suffix", async () => {
    const session = await sessionFor("duplicate-staff", "staff-password");
    const source = await createSource(session);
    const response = await app.inject({
      method: "POST",
      url: `/api/activities/${source.id}/duplicate`,
      headers: headers({
        cookie: session.cookies,
        "x-csrf-token": session.csrf,
        "idempotency-key": randomUUID(),
      }),
      payload: {},
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().title).toBe("春季赛（副本）");
  });

  it("replays the same command instead of creating a second copy", async () => {
    const session = await sessionFor("duplicate-staff", "staff-password");
    const source = await createSource(session);
    const commandId = randomUUID();
    const request = () =>
      app.inject({
        method: "POST",
        url: `/api/activities/${source.id}/duplicate`,
        headers: headers({
          cookie: session.cookies,
          "x-csrf-token": session.csrf,
          "idempotency-key": commandId,
        }),
        payload: {},
      });

    const first = await request();
    const second = await request();
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.json().id).toBe(first.json().id);
  });

  it("rejects a missing source and a caller without studio.manage", async () => {
    const session = await sessionFor("duplicate-staff", "staff-password");
    const missing = await app.inject({
      method: "POST",
      url: "/api/activities/act-missing/duplicate",
      headers: headers({
        cookie: session.cookies,
        "x-csrf-token": session.csrf,
        "idempotency-key": randomUUID(),
      }),
      payload: {},
    });
    expect(missing.statusCode).toBe(404);

    const username = `participant-${randomUUID().slice(0, 8)}`;
    const registered = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      headers: headers(),
      payload: { username, password: "participant-password" },
    });
    expect(registered.statusCode).toBe(201);
    const forbidden = await app.inject({
      method: "POST",
      url: `/api/activities/${(await createSource(session)).id}/duplicate`,
      headers: headers({
        cookie: setCookies(registered),
        "x-csrf-token": registered.json().csrfToken as string,
        "idempotency-key": randomUUID(),
      }),
      payload: {},
    });
    expect(forbidden.statusCode).toBe(403);
  });
});
