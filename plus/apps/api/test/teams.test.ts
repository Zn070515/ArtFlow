import { randomUUID } from "node:crypto";

import { closeDb, createDb, insertLocalAccount, insertRelease, migrate } from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import { compileTeamsDefinition, createTeamsDefinition } from "@artflow-plus/domain";
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
const schema = `artflow_api_teams_${Date.now()}_${process.pid}`;

let db: Kysely<Database>;
let admin: Client;
let app: FastifyInstance;
let token = "";
let observerToken = "";
const activityId = "teams-api-activity";

const deps: RuntimeDeps = {
  now: () => new Date().toISOString(),
  newEventId: () => randomUUID(),
};

async function command(
  method: "POST" | "PUT",
  url: string,
  payload: Record<string, unknown> | undefined,
  bearer = token,
): Promise<{ readonly statusCode: number; readonly json: () => any }> {
  return await app.inject({
    method,
    url,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${bearer}`,
      "idempotency-key": randomUUID(),
    },
    ...(payload === undefined ? {} : { payload }),
  }) as unknown as { statusCode: number; json: () => any };
}

async function login(username: string, password: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/token",
    headers: { "content-type": "application/json" },
    payload: { username, password },
  });
  return response.json().token as string;
}

describe.skipIf(!connectionString)("teams API", () => {
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
      username: "teams-api",
      passwordDigest: hashPassword("teams-api-password"),
      actor: {
        actorId: "teams-api",
        actorType: "user",
        roles: ["staff"],
        permissions: ["teams.manage", "teams.roster.correct"],
      },
      active: true,
    });
    await insertLocalAccount(db, {
      username: "teams-observer",
      passwordDigest: hashPassword("teams-observer-password"),
      actor: {
        actorId: "teams-observer",
        actorType: "user",
        roles: ["staff"],
        permissions: [],
      },
      active: true,
    });
    token = await login("teams-api", "teams-api-password");
    observerToken = await login("teams-observer", "teams-observer-password");

    const artifact = compileTeamsDefinition(createTeamsDefinition({ minSize: 1, maxSize: 3 }));
    if (!artifact.ok) throw new Error(JSON.stringify(artifact));
    await db.insertInto("activity").values({
      id: activityId,
      public_code: "TEAM-API",
      title: "Teams API",
      status: "active",
      revision: 1,
      enabled_capabilities: JSON.stringify(["registration", "teams"]),
      active_definition_version: 1,
    }).execute();
    for (const [index, participantId] of ["p1", "p2"].entries()) {
      await db.insertInto("registration").values({
        id: `reg-${activityId}-${participantId}`,
        activity_id: activityId,
        participant_id: participantId,
        questionnaire_version: "v1",
        questionnaire_hash: "hash",
        status: "approved",
        answers: JSON.stringify({ name: `选手${index + 1}` }),
        revision: 1,
        review_note: "",
        reviewed_by: "staff",
        created_at: new Date(),
        updated_at: new Date(),
      }).execute();
    }
    await insertRelease(db, {
      activityId,
      version: 1,
      contentHash: "teams-api-release",
      capabilities: { teams: artifact },
      executionPolicy: {
        declaredScopes: [],
        conflicts: {},
        runtimeContractVersion: 2,
        commandScopes: {},
      },
      capabilityVersions: { teams: "1.0.0" },
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

  it("creates, fills and freezes a team roster", async () => {
    const created = await command("POST", `/api/activities/${activityId}/teams`, {
      teamKey: "alpha",
      name: "Alpha",
    });
    expect(created.statusCode).toBe(201);
    const team = created.json() as { id: string; revision: number };

    const added = await command("POST", `/api/activities/${activityId}/teams/${team.id}/members`, {
      participantId: "p1",
      role: "member",
      expectedRevision: team.revision,
    });
    expect(added.statusCode).toBe(200);
    expect(added.json().revision).toBe(1);

    const frozen = await command("POST", `/api/activities/${activityId}/teams/freeze`, {});
    expect(frozen.statusCode).toBe(201);
    expect(frozen.json().frozenCount).toBe(1);

    const view = await app.inject({
      method: "GET",
      url: `/api/activities/${activityId}/teams`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(view.statusCode).toBe(200);
    expect(view.json().rosterFrozen).toBe(true);
    expect(view.json().teams[0]).toMatchObject({ name: "Alpha", status: "frozen" });
    expect(view.json().teams[0].members).toHaveLength(1);

    const late = await command("POST", `/api/activities/${activityId}/teams/${team.id}/members`, {
      participantId: "p2",
      expectedRevision: view.json().teams[0].revision,
    });
    expect(late.statusCode).toBe(409);
    expect(late.json().code).toBe("TEAM_ROSTER_FROZEN");
  });

  it("denies a staff account without a teams permission", async () => {
    const response = await command(
      "POST",
      `/api/activities/${activityId}/teams`,
      { teamKey: "beta", name: "Beta" },
      observerToken,
    );
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("FORBIDDEN");

    const view = await app.inject({
      method: "GET",
      url: `/api/activities/${activityId}/teams`,
      headers: { authorization: `Bearer ${observerToken}` },
    });
    expect(view.statusCode).toBe(403);
  });
});
