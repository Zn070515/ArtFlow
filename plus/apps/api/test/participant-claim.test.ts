import { randomUUID } from "node:crypto";

import {
  closeDb,
  createDb,
  getParticipantClaimByDigestForUpdate,
  insertLocalAccount,
  insertRegistration,
  migrate,
} from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import { hashPassword, MemoryRateLimiter, stableHash } from "@artflow-plus/runtime";
import type { RuntimeDeps } from "@artflow-plus/runtime";
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_api_participant_claim_${Date.now()}_${process.pid}`;

let db: Kysely<Database>;
let admin: Client;
let app: FastifyInstance;

const deps: RuntimeDeps = {
  now: () => "2026-11-01T00:00:00.000Z",
  newEventId: () => `evt-${randomUUID()}`,
  credentialSecret: "api-participant-claim-secret",
};

function headers(extra: Record<string, string> = {}) {
  return { "content-type": "application/json", ...extra };
}

function cookies(response: { headers: Record<string, unknown> }): string {
  const raw = response.headers["set-cookie"];
  const values = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  return values.map((value) => String(value).split(";")[0]).join("; ");
}

async function seedRegistration(): Promise<{
  readonly activityId: string;
  readonly registrationId: string;
  readonly legacyParticipantId: string;
}> {
  const activityId = `act-${randomUUID()}`;
  const registrationId = `reg-${randomUUID()}`;
  const legacyParticipantId = `legacy-user:${randomUUID()}`;
  await db.insertInto("activity").values({
    id: activityId,
    public_code: `CLAIM-${randomUUID().slice(0, 8)}`,
    title: "API participant claim",
    status: "active",
    revision: 1,
    enabled_capabilities: JSON.stringify(["registration"]),
    active_definition_version: 1,
  }).execute();
  await insertRegistration(db, {
    id: registrationId,
    activityId,
    participantId: legacyParticipantId,
    questionnaireVersion: "v1",
    questionnaireHash: "qhash",
    status: "submitted",
    answers: { name: "Imported" },
    revision: 1,
  });
  return { activityId, registrationId, legacyParticipantId };
}

async function staffToken(): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/token",
    headers: headers(),
    payload: { username: "claim-api-staff", password: "staff-password-123" },
  });
  expect(response.statusCode).toBe(200);
  return response.json().token as string;
}

async function issueClaim(seed: Awaited<ReturnType<typeof seedRegistration>>, key = `issue-${randomUUID()}`) {
  const response = await app.inject({
    method: "POST",
    url: `/api/activities/${seed.activityId}/registrations/${seed.registrationId}/account-claim`,
    headers: headers({ authorization: `Bearer ${await staffToken()}`, "idempotency-key": key }),
    payload: {},
  });
  expect(response.statusCode, response.body).toBe(201);
  return { response, key };
}

describe.skipIf(!connectionString)("participant claim API", () => {
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
      username: "claim-api-staff",
      passwordDigest: hashPassword("staff-password-123"),
      actor: {
        actorId: "claim-api-staff-actor",
        actorType: "user",
        roles: ["staff"],
        permissions: ["registration.review", "registration.manage"],
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

  it("returns the claim token once and redacts it on command replay", async () => {
    const seed = await seedRegistration();
    const issued = await issueClaim(seed, "api-claim-issue-replay");
    expect(issued.response.headers["cache-control"]).toBe("no-store");
    expect(issued.response.json().token).toMatch(/^AF1\.CLAIM\./);

    const replay = await app.inject({
      method: "POST",
      url: `/api/activities/${seed.activityId}/registrations/${seed.registrationId}/account-claim`,
      headers: headers({ authorization: `Bearer ${await staffToken()}`, "idempotency-key": issued.key }),
      payload: {},
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.json().token).toBeNull();
  });

  it("publishes a closed public claim body schema", () => {
    const document = app.swagger() as {
      readonly paths: Record<string, {
        readonly post?: {
          readonly requestBody?: {
            readonly content?: Record<string, { readonly schema?: { readonly additionalProperties?: boolean } }>;
          };
        };
      }>;
    };
    const schema = document.paths["/api/public/participant-claims/consume"]?.post?.requestBody?.content?.["application/json"]?.schema;
    expect(schema?.additionalProperties).toBe(false);
  });

  it("consumes a claim into a cookie session without exposing session credentials", async () => {
    const seed = await seedRegistration();
    const issued = await issueClaim(seed);
    const token = issued.response.json().token as string;
    const consumed = await app.inject({
      method: "POST",
      url: "/api/public/participant-claims/consume",
      headers: headers({ "idempotency-key": `api-claim-consume-${randomUUID()}` }),
      payload: {
        token,
        username: `claim-api-${randomUUID().slice(0, 8)}`,
        password: "claim-password-123",
      },
    });
    expect(consumed.statusCode, consumed.body).toBe(200);
    expect(consumed.headers["cache-control"]).toBe("no-store");
    expect(consumed.json().actor).toMatchObject({ roles: ["participant"] });
    expect(consumed.json().actor.authContext).toBeUndefined();
    expect(consumed.json().sessionToken).toBeUndefined();
    expect(consumed.json().csrfToken).toEqual(expect.any(String));
    expect(JSON.stringify(consumed.json())).not.toContain(token);
    expect(JSON.stringify(consumed.headers["set-cookie"])).toContain("artflow_session=");
    expect(JSON.stringify(consumed.headers["set-cookie"])).toContain("HttpOnly");
    expect(JSON.stringify(consumed.headers["set-cookie"])).toContain("SameSite=Strict");

    const rows = await Promise.all([
      db.selectFrom("command_receipt").selectAll().execute(),
      db.selectFrom("audit_entry").selectAll().execute(),
      db.selectFrom("outbox").selectAll().execute(),
    ]);
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it("requires CSRF for an existing participant session and rejects extra body fields", async () => {
    const seed = await seedRegistration();
    const issued = await issueClaim(seed);
    const username = `existing-claim-${randomUUID().slice(0, 8)}`;
    const registered = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      headers: headers(),
      payload: { username, password: "existing-password-123" },
    });
    expect(registered.statusCode).toBe(201);
    const sessionCookies = cookies(registered);
    const csrf = registered.json().csrfToken as string;
    const missingCsrf = await app.inject({
      method: "POST",
      url: "/api/public/participant-claims/consume",
      headers: headers({ cookie: sessionCookies, "idempotency-key": `missing-csrf-${randomUUID()}` }),
      payload: { token: issued.response.json().token },
    });
    expect(missingCsrf.statusCode).toBe(403);
    expect(missingCsrf.json().code).toBe("CSRF_INVALID");

    const extra = await app.inject({
      method: "POST",
      url: "/api/public/participant-claims/consume",
      headers: headers({ cookie: sessionCookies, "x-csrf-token": csrf, "idempotency-key": `extra-${randomUUID()}` }),
      payload: { token: issued.response.json().token, extra: true },
    });
    expect(extra.statusCode).toBe(400);
    expect(extra.json().code).toBe("VALIDATION_FAILED");

    const consumed = await app.inject({
      method: "POST",
      url: "/api/public/participant-claims/consume",
      headers: headers({ cookie: sessionCookies, "x-csrf-token": csrf, "idempotency-key": `existing-${randomUUID()}` }),
      payload: { token: issued.response.json().token },
    });
    expect(consumed.statusCode, consumed.body).toBe(200);
    expect(consumed.json().actor.actorId).toBe(registered.json().actor.actorId);
    expect(consumed.headers["set-cookie"]).toBeUndefined();
  });

  it("returns a generic invalid response and rate-limits public claims", async () => {
    const invalid = await app.inject({
      method: "POST",
      url: "/api/public/participant-claims/consume",
      headers: headers({ "idempotency-key": `invalid-${randomUUID()}` }),
      payload: { token: `AF1.CLAIM.invalid.${randomUUID()}`, username: "invalid-user", password: "claim-password-123" },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ code: "INVALID_PARTICIPANT_CLAIM", message: "The participant claim is invalid or expired." });

    const limited = await buildApp({ db, deps, rateLimiter: new MemoryRateLimiter() });
    await limited.ready();
    try {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const response = await limited.inject({
          method: "POST",
          url: "/api/public/participant-claims/consume",
          headers: headers({ "idempotency-key": `rate-${randomUUID()}` }),
          payload: { token: `AF1.CLAIM.invalid.${randomUUID()}`, username: `rate-${attempt}`, password: "claim-password-123" },
        });
        expect(response.statusCode).toBe(400);
      }
      const blocked = await limited.inject({
        method: "POST",
        url: "/api/public/participant-claims/consume",
        headers: headers({ "idempotency-key": `rate-blocked-${randomUUID()}` }),
        payload: { token: `AF1.CLAIM.invalid.${randomUUID()}`, username: "rate-blocked", password: "claim-password-123" },
      });
      expect(blocked.statusCode).toBe(429);
    } finally {
      await limited.close();
    }
  });

  it("preserves a claim when the requested username is already taken", async () => {
    const seed = await seedRegistration();
    const issued = await issueClaim(seed);
    const username = `taken-claim-${randomUUID().slice(0, 8)}`;
    await insertLocalAccount(db, {
      username,
      passwordDigest: hashPassword("existing-password-123"),
      actor: {
        actorId: `participant:${randomUUID()}`,
        actorType: "user",
        roles: ["participant"],
        permissions: [],
      },
      active: true,
    });
    const consumed = await app.inject({
      method: "POST",
      url: "/api/public/participant-claims/consume",
      headers: headers({ "idempotency-key": `taken-${randomUUID()}` }),
      payload: { token: issued.response.json().token, username, password: "claim-password-123" },
    });
    expect(consumed.statusCode).toBe(409);
    expect(consumed.json().code).toBe("USERNAME_TAKEN");
    await expect(getParticipantClaimByDigestForUpdate(db, stableHash(issued.response.json().token as string)))
      .resolves.toMatchObject({ consumedAt: null, consumedByActorId: null });
  });
});
