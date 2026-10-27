import { randomUUID } from "node:crypto";

import { closeDb, createDb, insertLocalAccount, migrate } from "@artflow-plus/db";
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
const schema = `artflow_api_auth_${Date.now()}_${process.pid}`;

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

async function login(username: string, password: string) {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: headers(),
    payload: { username, password },
  });
  return response;
}

async function token(username: string, password: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/token",
    headers: headers(),
    payload: { username, password },
  });
  expect(response.statusCode).toBe(200);
  return response.json().token as string;
}

async function seedActivity(status = "active"): Promise<string> {
  const activityId = `act-${randomUUID()}`;
  await db.insertInto("activity").values({
    id: activityId,
    public_code: activityId,
    title: "Auth test",
    status,
    revision: 1,
    enabled_capabilities: JSON.stringify([]),
    active_definition_version: 1,
  }).execute();
  return activityId;
}

describe.skipIf(!connectionString)("cookie auth and CSRF", () => {
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
      username: "auth-staff",
      passwordDigest: hashPassword("staff-password"),
      actor: {
        actorId: "staff-1",
        actorType: "user",
        roles: ["staff"],
        permissions: ["registration.review", "studio.manage"],
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

  it("sets cookies, serves me, and revokes on logout", async () => {
    const loggedIn = await login("auth-staff", "staff-password");
    expect(loggedIn.statusCode).toBe(200);
    const cookies = setCookies(loggedIn);
    expect(cookies).toContain("artflow_session=");
    expect(cookies).toContain("artflow_csrf=");
    const raw = loggedIn.headers["set-cookie"];
    expect(JSON.stringify(raw)).toContain("HttpOnly");
    expect(JSON.stringify(raw)).toContain("SameSite=Strict");
    // The browser login must not return the session secret to JavaScript.
    expect(loggedIn.json().token).toBeUndefined();
    expect(loggedIn.json().csrfToken).toEqual(expect.any(String));
    expect(loggedIn.json().actor.authContext).toBeUndefined();

    const me = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: cookies },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ actor: { actorId: "staff-1" } });

    const loggedOut = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { cookie: cookies },
    });
    expect(loggedOut.statusCode).toBe(200);
    const after = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: cookies },
    });
    expect(after.statusCode).toBe(401);
  });

  it("issues bearer tokens only from the programmatic endpoint", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/token",
      headers: headers(),
      payload: { username: "auth-staff", password: "staff-password" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().token).toEqual(expect.any(String));
    expect(response.headers["set-cookie"]).toBeUndefined();
  });

  it("requires CSRF for cookie mutations but not for bearer clients", async () => {
    const loggedIn = await login("auth-staff", "staff-password");
    const cookies = setCookies(loggedIn);
    const csrf = loggedIn.json().csrfToken as string;
    const activityId = await seedActivity();
    const missing = await app.inject({
      method: "POST",
      url: `/api/activities/${activityId}/close`,
      headers: headers({ "idempotency-key": `close-missing-${activityId}`, cookie: cookies }),
      payload: { expectedRevision: 1 },
    });
    expect(missing.statusCode).toBe(403);
    expect(missing.json().code).toBe("CSRF_INVALID");

    const valid = await app.inject({
      method: "POST",
      url: `/api/activities/${activityId}/close`,
      headers: headers({ "idempotency-key": `close-valid-${activityId}`, cookie: cookies, "x-csrf-token": csrf }),
      payload: { expectedRevision: 1 },
    });
    expect(valid.statusCode, valid.body).toBe(200);
    expect(valid.json()).toMatchObject({ status: "closed" });

    const bearerActivity = await seedActivity();
    const bearerToken = await token("auth-staff", "staff-password");
    const bearer = await app.inject({
      method: "POST",
      url: `/api/activities/${bearerActivity}/close`,
      headers: headers({ "idempotency-key": `close-bearer-${bearerActivity}`, authorization: `Bearer ${bearerToken}` }),
      payload: { expectedRevision: 1 },
    });
    expect(bearer.statusCode).toBe(200);
  });

  it("requires a lifecycle permission to close an activity", async () => {
    const username = `closer-${randomUUID().slice(0, 8)}`;
    const registered = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      headers: headers(),
      payload: { username, password: "participant-password" },
    });
    expect(registered.statusCode).toBe(201);
    expect(registered.json().token).toBeUndefined();
    const cookies = setCookies(registered);
    const csrf = registered.json().csrfToken as string;
    const activityId = await seedActivity();
    const response = await app.inject({
      method: "POST",
      url: `/api/activities/${activityId}/close`,
      headers: headers({
        "idempotency-key": `close-forbidden-${activityId}`,
        cookie: cookies,
        "x-csrf-token": csrf,
      }),
      payload: { expectedRevision: 1 },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("FORBIDDEN");
  });

  it("rate limits password guesses per IP and per username", async () => {
    const limited = await buildApp({ db, deps, rateLimiter: new MemoryRateLimiter() });
    await limited.ready();
    try {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const response = await limited.inject({
          method: "POST",
          url: "/api/auth/login",
          headers: headers(),
          payload: { username: `guess-${attempt}`, password: "wrong-password" },
        });
        expect(response.statusCode).toBe(401);
      }
      const blockedByIp = await limited.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: headers(),
        payload: { username: "guess-10", password: "wrong-password" },
      });
      expect(blockedByIp.statusCode).toBe(429);

      for (let attempt = 0; attempt < 20; attempt += 1) {
        const response = await limited.inject({
          method: "POST",
          url: "/api/auth/login",
          headers: headers(),
          remoteAddress: `10.0.1.${attempt}`,
          payload: { username: "auth-staff", password: "wrong-password" },
        });
        expect(response.statusCode).toBe(401);
      }
      const blockedByUsername = await limited.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: headers(),
        remoteAddress: "10.0.2.1",
        payload: { username: "auth-staff", password: "wrong-password" },
      });
      expect(blockedByUsername.statusCode).toBe(429);
    } finally {
      await limited.close();
    }
  });

  it("registers participants and rejects duplicate usernames", async () => {
    const username = `participant-${randomUUID().slice(0, 8)}`;
    const registered = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      headers: headers(),
      payload: { username, password: "participant-password" },
    });
    expect(registered.statusCode).toBe(201);
    expect(registered.json().token).toBeUndefined();
    expect(registered.json().actor).toMatchObject({ roles: ["participant"], permissions: [] });
    expect(registered.json().actor.authContext).toBeUndefined();
    const cookies = setCookies(registered);
    const me = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: cookies },
    });
    expect(me.statusCode).toBe(200);

    const duplicate = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      headers: headers(),
      payload: { username, password: "participant-password" },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().code).toBe("USERNAME_TAKEN");
  });

  it("rejects weak registration input", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      headers: headers(),
      payload: { username: "ab", password: "short" },
    });
    expect(response.statusCode).toBe(400);
  });
});
