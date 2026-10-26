import { randomUUID } from "node:crypto";

import { closeDb, createDb, migrate } from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import type { ActorContext } from "@artflow-plus/domain";
import { createEmptyCompetitionDefinition } from "@artflow-plus/domain";
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
const schema = `artflow_api_studio_${Date.now()}_${process.pid}`;

let db: Kysely<Database>;
let admin: Client;
let studioApp: FastifyInstance;
let participantApp: FastifyInstance;

const deps: RuntimeDeps = {
  now: () => new Date().toISOString(),
  newEventId: () => randomUUID(),
};
const studio: ActorContext = {
  actorId: "studio-staff",
  actorType: "user",
  roles: ["staff"],
  permissions: ["studio.manage"],
};
const participant: ActorContext = {
  actorId: "studio-participant",
  actorType: "user",
  roles: ["participant"],
  permissions: [],
};

function headers() {
  return { "idempotency-key": `cmd-${randomUUID()}`, "content-type": "application/json" };
}

describe.skipIf(!connectionString)("Studio API", () => {
  beforeAll(async () => {
    if (!connectionString) return;
    admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = createDb({ connectionString, schema });
    await migrate(db);
    studioApp = await buildApp({ db, deps, actor: studio });
    participantApp = await buildApp({ db, deps, actor: participant });
    await Promise.all([studioApp.ready(), participantApp.ready()]);
  });

  afterAll(async () => {
    if (!connectionString) return;
    await Promise.all([studioApp.close(), participantApp.close()]);
    await closeDb(db);
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });

  it("runs the Studio definition and session lifecycle with studio.manage", async () => {
    const created = await studioApp.inject({
      method: "POST",
      url: "/api/activities",
      headers: headers(),
      payload: { title: "Studio E2E", capabilities: ["competition"] },
    });
    expect(created.statusCode).toBe(201);
    const activity = created.json() as { id: string; revision: number };

    const forbiddenCreate = await participantApp.inject({
      method: "POST",
      url: "/api/activities",
      headers: headers(),
      payload: { title: "Nope", capabilities: ["competition"] },
    });
    expect(forbiddenCreate.statusCode).toBe(403);
    const forbiddenState = await participantApp.inject({
      method: "GET",
      url: `/api/activities/${activity.id}/studio`,
    });
    expect(forbiddenState.statusCode).toBe(403);

    const activated = await studioApp.inject({
      method: "POST",
      url: `/api/activities/${activity.id}/activate`,
      headers: headers(),
      payload: { expectedRevision: activity.revision },
    });
    expect(activated.statusCode).toBe(200);

    const compiled = await studioApp.inject({
      method: "POST",
      url: `/api/activities/${activity.id}/definitions/compile`,
      headers: headers(),
      payload: {
        package: {
          schemaVersion: 1,
          manifest: { key: "studio-e2e", title: "Studio E2E" },
          capabilities: { competition: createEmptyCompetitionDefinition() },
          bindings: [],
        },
      },
    });
    expect(compiled.statusCode).toBe(200);
    const draftRevision = compiled.json().draftRevision as number;

    const released = await studioApp.inject({
      method: "POST",
      url: `/api/activities/${activity.id}/definitions/release`,
      headers: headers(),
      payload: { expectedDraftRevision: draftRevision },
    });
    expect(released.statusCode).toBe(201);
    expect(released.json()).toMatchObject({ version: 1 });

    const state = await studioApp.inject({
      method: "GET",
      url: `/api/activities/${activity.id}/studio`,
    });
    expect(state.statusCode).toBe(200);
    const body = state.json() as {
      compiled: { capabilities: string[] };
      releases: { version: number; active: boolean; declaredScopes: string[] }[];
      sessions: unknown[];
    };
    expect(body.compiled.capabilities).toEqual(["competition"]);
    expect(body.releases).toHaveLength(1);
    expect(body.releases[0]).toMatchObject({ version: 1, active: true });
    expect(body.sessions).toHaveLength(0);
    const scope = body.releases[0]?.declaredScopes[0];
    expect(scope).toEqual(expect.any(String));

    const session = await studioApp.inject({
      method: "POST",
      url: `/api/activities/${activity.id}/executions`,
      headers: headers(),
      payload: { scope, mode: "rehearsal" },
    });
    expect(session.statusCode).toBe(201);
    const sessionBody = session.json() as { id: string; revision: number };

    const afterStart = await studioApp.inject({
      method: "GET",
      url: `/api/activities/${activity.id}/studio`,
    });
    expect((afterStart.json() as { sessions: unknown[] }).sessions).toHaveLength(1);

    const closed = await studioApp.inject({
      method: "POST",
      url: `/api/activities/${activity.id}/executions/${sessionBody.id}/close`,
      headers: headers(),
      payload: { expectedRevision: sessionBody.revision },
    });
    expect(closed.statusCode).toBe(200);
    expect(closed.json()).toMatchObject({ status: "closed" });
  });
});
