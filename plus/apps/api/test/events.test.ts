import { randomUUID } from "node:crypto";

import { closeDb, createDb, migrate } from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import { createEmptyCompetitionDefinition } from "@artflow-plus/domain";
import type { ActorContext } from "@artflow-plus/domain";
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import { Client } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import { buildApp } from "../src/app.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_events_${Date.now()}_${process.pid}`;

let app: FastifyInstance;
let anonymousApp: FastifyInstance;
let db: Kysely<Database>;
let admin: Client;
let baseUrl = "";

const studioActor: ActorContext = {
  actorId: "sse-studio",
  actorType: "user",
  roles: ["staff"],
  permissions: ["studio.manage"],
};

const dbIt = connectionString ? it : it.skip;

function headers() {
  return {
    "idempotency-key": `cmd-${randomUUID()}`,
    "content-type": "application/json",
  };
}

async function post(path: string, payload: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(payload),
  });
}

async function releasedActivity(): Promise<string> {
  const created = (await (
    await post("/api/activities", { title: "SSE", capabilities: ["competition"] })
  ).json()) as { id: string; revision: number };
  await post(`/api/activities/${created.id}/activate`, {
    expectedRevision: created.revision,
  });
  const compiled = (await (
    await post(`/api/activities/${created.id}/definitions/compile`, {
      package: {
        schemaVersion: 1,
        manifest: { key: "pkg", title: "SSE" },
        capabilities: { competition: createEmptyCompetitionDefinition() },
        bindings: [],
      },
    })
  ).json()) as { draftRevision: number };
  await post(`/api/activities/${created.id}/definitions/release`, {
    expectedDraftRevision: compiled.draftRevision,
  });
  return created.id;
}

beforeAll(async () => {
  if (!connectionString) return;
  admin = new Client({ connectionString });
  await admin.connect();
  await admin.query(`CREATE SCHEMA "${schema}"`);
  db = createDb({ connectionString, schema });
  await migrate(db);
  app = await buildApp({ db, actor: studioActor });
  anonymousApp = await buildApp({ db });
  await anonymousApp.ready();
  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  baseUrl = address.replace("127.0.0.1", "localhost");
});

afterAll(async () => {
  if (!connectionString) return;
  await anonymousApp.close();
  await app.close();
  await closeDb(db);
  await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  await admin.end();
});

dbIt("serves events through the HTTP cursor", async () => {
  const activityId = await releasedActivity();
  const started = await post(`/api/activities/${activityId}/executions`, {
    scope: "stage",
    mode: "formal",
  });
  expect(started.status).toBe(201);

  const first = await fetch(
    `${baseUrl}/api/activities/${activityId}/events?mode=formal&after=0`,
  );
  const feed = (await first.json()) as {
    events: { sequence: number; type: string }[];
    headCursor: number;
  };
  const startedEvent = feed.events.find((event) => event.type === "ExecutionSessionStarted");
  expect(startedEvent).toBeDefined();
  expect(startedEvent?.sequence ?? 0).toBeGreaterThan(0);

  const after = await fetch(
    `${baseUrl}/api/activities/${activityId}/events?mode=formal&after=${startedEvent?.sequence ?? 0}`,
  );
  const tail = (await after.json()) as {
    events: { sequence: number }[];
    headCursor: number;
  };
  expect(tail.events.every((event) => event.sequence > (startedEvent?.sequence ?? 0))).toBe(true);
});

dbIt("requires an operations session for the event feed", async () => {
  const activityId = await releasedActivity();
  const events = await anonymousApp.inject({
    method: "GET",
    url: `/api/activities/${activityId}/events`,
  });
  expect(events.statusCode).toBe(401);
});
