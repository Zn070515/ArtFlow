import { randomUUID } from "node:crypto";

import { closeDb, createDb, insertLocalAccount, migrate } from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import { hashPassword, MemoryRateLimiter, totpCode } from "@artflow-plus/runtime";
import type { Mailer, PasswordResetMessage, RuntimeDeps } from "@artflow-plus/runtime";
import type { FastifyInstance } from "fastify";
import { Client } from "pg";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_api_identity_${Date.now()}_${process.pid}`;

let db: Kysely<Database>;
let admin: Client;
let app: FastifyInstance;
let sent: PasswordResetMessage[] = [];

const mailer: Mailer = {
  async sendPasswordReset(message) {
    sent.push(message);
  },
};
const deps: RuntimeDeps = {
  now: () => new Date().toISOString(),
  newEventId: () => randomUUID(),
  mailer,
};

const headers = { "content-type": "application/json" };

async function bearer(username: string, password: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/token",
    headers,
    payload: { username, password },
  });
  expect(response.statusCode).toBe(200);
  return response.json().token as string;
}

describe.skipIf(!connectionString)("account identity recovery", () => {
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
      username: "identity-user",
      passwordDigest: hashPassword("identity-password-1"),
      email: "identity@example.com",
      actor: {
        actorId: "identity-1",
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

  it("resets a password through a one-time emailed token", async () => {
    sent = [];
    const forgot = await app.inject({
      method: "POST",
      url: "/api/auth/password/forgot",
      headers,
      payload: { identifier: "identity@example.com" },
    });
    expect(forgot.statusCode).toBe(200);
    expect(forgot.json()).toEqual({ ok: true });
    expect(sent).toHaveLength(1);
    const token = sent[0]?.resetUrl.split("#")[1] ?? "";
    expect(token.length).toBeGreaterThan(20);

    const reset = await app.inject({
      method: "POST",
      url: "/api/auth/password/reset",
      headers,
      payload: { token, password: "identity-password-2" },
    });
    expect(reset.statusCode).toBe(200);

    const oldLogin = await app.inject({
      method: "POST",
      url: "/api/auth/token",
      headers,
      payload: { username: "identity-user", password: "identity-password-1" },
    });
    expect(oldLogin.statusCode).toBe(401);
    await expect(bearer("identity-user", "identity-password-2")).resolves.toEqual(expect.any(String));

    const reuse = await app.inject({
      method: "POST",
      url: "/api/auth/password/reset",
      headers,
      payload: { token, password: "identity-password-3" },
    });
    expect(reuse.statusCode).toBe(400);
    expect(reuse.json().code).toBe("RESET_TOKEN_INVALID");
  });

  it("requires TOTP after enrollment and accepts one valid code", async () => {
    const token = await bearer("identity-user", "identity-password-2");
    const authorization = { authorization: `Bearer ${token}` };
    const enroll = await app.inject({
      method: "POST",
      url: "/api/auth/mfa/enroll",
      headers: { ...headers, ...authorization },
      payload: {},
    });
    expect(enroll.statusCode).toBe(200);
    const secret = enroll.json().secret as string;
    const code = totpCode(secret, Date.now());
    const confirm = await app.inject({
      method: "POST",
      url: "/api/auth/mfa/confirm",
      headers: { ...headers, ...authorization },
      payload: { code },
    });
    expect(confirm.statusCode).toBe(200);

    const challenge = await app.inject({
      method: "POST",
      url: "/api/auth/token",
      headers,
      payload: { username: "identity-user", password: "identity-password-2" },
    });
    expect(challenge.statusCode).toBe(200);
    expect(challenge.json().mfaRequired).toBe(true);
    expect(challenge.json().token).toBeUndefined();
    const challengeValue = challenge.json().challenge as string;

    const wrong = await app.inject({
      method: "POST",
      url: "/api/auth/mfa",
      headers,
      payload: { challenge: challengeValue, code: "000000" },
    });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().code).toBe("MFA_INVALID");

    const verified = await app.inject({
      method: "POST",
      url: "/api/auth/mfa",
      headers,
      payload: { challenge: challengeValue, code: totpCode(secret, Date.now()) },
    });
    expect(verified.statusCode).toBe(200);
    expect(verified.json().actor.actorId).toBe("identity-1");
  });

  it("advertises OIDC as disabled when no provider is configured", async () => {
    const response = await app.inject({ method: "GET", url: "/api/auth/oidc/config" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ enabled: false });
  });
});
