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
const schema = `artflow_api_invite_${Date.now()}_${process.pid}`;

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

async function adminSession() {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: headers(),
    payload: { username: "invite-admin", password: "admin-password" },
  });
  expect(response.statusCode).toBe(200);
  return {
    cookies: setCookies(response),
    csrf: response.json().csrfToken as string,
  };
}

async function createInvite(username: string, session: { cookies: string; csrf: string }) {
  return app.inject({
    method: "POST",
    url: "/api/admin/accounts/invites",
    headers: headers({ cookie: session.cookies, "x-csrf-token": session.csrf }),
    payload: { username, roles: ["staff"], permissions: ["studio.manage"] },
  });
}

describe.skipIf(!connectionString)("account invitations", () => {
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
      username: "invite-admin",
      passwordDigest: hashPassword("admin-password"),
      actor: {
        actorId: "invite-admin-1",
        actorType: "user",
        roles: ["admin"],
        permissions: ["account.manage"],
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

  it("invites a new account without a password and previews the token", async () => {
    const session = await adminSession();
    const username = `invited-${randomUUID().slice(0, 8)}`;
    const created = await createInvite(username, session);
    expect(created.statusCode).toBe(201);
    const invite = created.json();
    expect(invite.account).toMatchObject({ username, active: false, invited: true });
    expect(invite.token).toEqual(expect.any(String));

    const preview = await app.inject({
      method: "POST",
      url: "/api/auth/invite-preview",
      headers: headers(),
      payload: { token: invite.token },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().username).toBe(username);

    const list = await app.inject({
      method: "GET",
      url: "/api/admin/accounts",
      headers: { cookie: session.cookies },
    });
    expect(list.json().accounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ username, invited: true, active: false }),
      ]),
    );
  });

  it("claims the invitation once and issues a working session", async () => {
    const session = await adminSession();
    const username = `claim-${randomUUID().slice(0, 8)}`;
    const invite = (await createInvite(username, session)).json();
    const password = "invite-password-123";

    const claimed = await app.inject({
      method: "POST",
      url: "/api/auth/claim-invite",
      headers: headers(),
      payload: { token: invite.token, password },
    });
    expect(claimed.statusCode).toBe(201);
    expect(claimed.json().actor.actorId).toBe(`user:${username}`);
    const cookies = setCookies(claimed);

    const me = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: cookies },
    });
    expect(me.statusCode).toBe(200);

    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: headers(),
      payload: { username, password },
    });
    expect(login.statusCode).toBe(200);

    const reused = await app.inject({
      method: "POST",
      url: "/api/auth/claim-invite",
      headers: headers(),
      payload: { token: invite.token, password },
    });
    expect(reused.statusCode).toBe(409);
    expect(reused.json().code).toBe("INVITE_CLAIMED");
  });

  it("rejects unknown, expired, and weak invitations", async () => {
    const session = await adminSession();
    const unknown = await app.inject({
      method: "POST",
      url: "/api/auth/claim-invite",
      headers: headers(),
      payload: { token: "not-a-token", password: "invite-password-123" },
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().code).toBe("INVITE_INVALID");

    const username = `expired-${randomUUID().slice(0, 8)}`;
    const invite = (await createInvite(username, session)).json();
    await db.updateTable("account_invite")
      .set({ expires_at: new Date(Date.now() - 60_000) })
      .where("username", "=", username)
      .execute();
    const expired = await app.inject({
      method: "POST",
      url: "/api/auth/claim-invite",
      headers: headers(),
      payload: { token: invite.token, password: "invite-password-123" },
    });
    expect(expired.statusCode).toBe(409);
    expect(expired.json().code).toBe("INVITE_EXPIRED");

    const weak = await app.inject({
      method: "POST",
      url: "/api/auth/claim-invite",
      headers: headers(),
      payload: { token: invite.token, password: "short" },
    });
    expect(weak.statusCode).toBe(400);
  });

  it("revokes an open invitation", async () => {
    const session = await adminSession();
    const username = `revoke-${randomUUID().slice(0, 8)}`;
    const invite = (await createInvite(username, session)).json();

    const revoked = await app.inject({
      method: "DELETE",
      url: `/api/admin/accounts/${username}/invite`,
      headers: { cookie: session.cookies, "x-csrf-token": session.csrf },
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json().revoked).toBe(1);

    const preview = await app.inject({
      method: "POST",
      url: "/api/auth/invite-preview",
      headers: headers(),
      payload: { token: invite.token },
    });
    expect(preview.statusCode).toBe(404);
  });

  it("refuses to reinvite an active account or without account.manage", async () => {
    const session = await adminSession();
    const active = await app.inject({
      method: "POST",
      url: "/api/admin/accounts/invites",
      headers: headers({ cookie: session.cookies, "x-csrf-token": session.csrf }),
      payload: {
        username: "invite-admin",
        roles: ["admin"],
        permissions: ["account.manage"],
      },
    });
    expect(active.statusCode).toBe(409);
    expect(active.json().code).toBe("ACCOUNT_ACTIVE");

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
      url: "/api/admin/accounts/invites",
      headers: headers({
        cookie: setCookies(registered),
        "x-csrf-token": registered.json().csrfToken as string,
      }),
      payload: { username: "another-user", roles: ["staff"], permissions: [] },
    });
    expect(forbidden.statusCode).toBe(403);
  });
});
