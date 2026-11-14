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
const schema = `artflow_api_admin_${Date.now()}_${process.pid}`;

// This file exercises many account transitions from one loopback address; the
// production login budget is intentionally lower than the test's request count.
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

async function login(username: string, password: string) {
  return app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: headers(),
    payload: { username, password },
  });
}

async function sessionFor(username: string, password: string) {
  const response = await login(username, password);
  expect(response.statusCode).toBe(200);
  return {
    cookies: setCookies(response),
    csrf: response.json().csrfToken as string,
  };
}

describe.skipIf(!connectionString)("account administration", () => {
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
      username: "account-admin",
      passwordDigest: hashPassword("admin-password"),
      actor: {
        actorId: "account-admin-1",
        actorType: "user",
        roles: ["admin"],
        permissions: ["account.manage", "studio.manage"],
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

  it("rejects account management without account.manage", async () => {
    const username = `plain-${randomUUID().slice(0, 8)}`;
    const registered = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      headers: headers(),
      payload: { username, password: "participant-password" },
    });
    expect(registered.statusCode).toBe(201);
    const cookies = setCookies(registered);
    const response = await app.inject({
      method: "GET",
      url: "/api/admin/accounts",
      headers: { cookie: cookies },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("FORBIDDEN");
  });

  it("lists accounts for an administrator", async () => {
    const session = await sessionFor("account-admin", "admin-password");
    const response = await app.inject({
      method: "GET",
      url: "/api/admin/accounts",
      headers: { cookie: session.cookies },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().accounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          username: "account-admin",
          permissions: expect.arrayContaining(["account.manage"]),
          active: true,
        }),
      ]),
    );
  });

  it("creates a staff account that can sign in, and rejects a duplicate", async () => {
    const session = await sessionFor("account-admin", "admin-password");
    const username = `staff-${randomUUID().slice(0, 8)}`;
    const created = await app.inject({
      method: "POST",
      url: "/api/admin/accounts",
      headers: headers({ cookie: session.cookies, "x-csrf-token": session.csrf }),
      payload: {
        username,
        password: "staff-password",
        roles: ["staff"],
        permissions: ["registration.review"],
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().account).toMatchObject({
      username,
      roles: ["staff"],
      permissions: ["registration.review"],
      active: true,
    });

    const signedIn = await login(username, "staff-password");
    expect(signedIn.statusCode).toBe(200);

    const duplicate = await app.inject({
      method: "POST",
      url: "/api/admin/accounts",
      headers: headers({ cookie: session.cookies, "x-csrf-token": session.csrf }),
      payload: {
        username,
        password: "staff-password",
        roles: ["staff"],
        permissions: [],
      },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().code).toBe("USERNAME_TAKEN");
  });

  it("applies permission edits to an existing session immediately", async () => {
    const adminSession = await sessionFor("account-admin", "admin-password");
    const username = `edited-${randomUUID().slice(0, 8)}`;
    const created = await app.inject({
      method: "POST",
      url: "/api/admin/accounts",
      headers: headers({ cookie: adminSession.cookies, "x-csrf-token": adminSession.csrf }),
      payload: {
        username,
        password: "staff-password",
        roles: ["staff"],
        permissions: ["studio.manage"],
      },
    });
    expect(created.statusCode).toBe(201);
    const staffSession = await sessionFor(username, "staff-password");

    const updated = await app.inject({
      method: "PUT",
      url: `/api/admin/accounts/${username}`,
      headers: headers({ cookie: adminSession.cookies, "x-csrf-token": adminSession.csrf }),
      payload: { permissions: [] },
    });
    expect(updated.statusCode).toBe(200);

    const me = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: staffSession.cookies },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().actor.permissions).toEqual([]);
  });

  it("deactivates an account and ends its sessions", async () => {
    const adminSession = await sessionFor("account-admin", "admin-password");
    const username = `disabled-${randomUUID().slice(0, 8)}`;
    await app.inject({
      method: "POST",
      url: "/api/admin/accounts",
      headers: headers({ cookie: adminSession.cookies, "x-csrf-token": adminSession.csrf }),
      payload: {
        username,
        password: "staff-password",
        roles: ["staff"],
        permissions: ["studio.manage"],
      },
    });
    const staffSession = await sessionFor(username, "staff-password");

    const deactivated = await app.inject({
      method: "PUT",
      url: `/api/admin/accounts/${username}`,
      headers: headers({ cookie: adminSession.cookies, "x-csrf-token": adminSession.csrf }),
      payload: { active: false },
    });
    expect(deactivated.statusCode).toBe(200);
    expect(deactivated.json().account.active).toBe(false);

    const me = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: staffSession.cookies },
    });
    expect(me.statusCode).toBe(401);

    const relogin = await login(username, "staff-password");
    expect(relogin.statusCode).toBe(401);
  });

  it("revokes every session without changing permissions", async () => {
    const adminSession = await sessionFor("account-admin", "admin-password");
    const username = `revoked-${randomUUID().slice(0, 8)}`;
    await app.inject({
      method: "POST",
      url: "/api/admin/accounts",
      headers: headers({ cookie: adminSession.cookies, "x-csrf-token": adminSession.csrf }),
      payload: {
        username,
        password: "staff-password",
        roles: ["staff"],
        permissions: ["studio.manage"],
      },
    });
    const staffSession = await sessionFor(username, "staff-password");

    const revoked = await app.inject({
      method: "POST",
      url: `/api/admin/accounts/${username}/revoke-sessions`,
      headers: headers({ cookie: adminSession.cookies, "x-csrf-token": adminSession.csrf }),
      payload: {},
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json().revoked).toBeGreaterThanOrEqual(1);

    const me = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: staffSession.cookies },
    });
    expect(me.statusCode).toBe(401);

    const relogin = await login(username, "staff-password");
    expect(relogin.statusCode).toBe(200);
  });

  it("refuses to remove the last administrator", async () => {
    const adminSession = await sessionFor("account-admin", "admin-password");
    const response = await app.inject({
      method: "PUT",
      url: "/api/admin/accounts/account-admin",
      headers: headers({ cookie: adminSession.cookies, "x-csrf-token": adminSession.csrf }),
      payload: { permissions: [] },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("LAST_ADMIN");
  });
});
