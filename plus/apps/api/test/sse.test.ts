import { randomUUID } from "node:crypto";

import { closeDb, createDb, migrate } from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import { createEmptyCompetitionDefinition } from "@artflow-plus/domain";
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import { Client } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import { buildApp } from "../src/app.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_sse_${Date.now()}_${process.pid}`;

let app: FastifyInstance;
let db: Kysely<Database>;
let admin: Client;
let baseUrl = "";

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
  app = await buildApp({ db });
  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  baseUrl = address.replace("127.0.0.1", "localhost");
});

afterAll(async () => {
  if (!connectionString) return;
  await app.close();
  await closeDb(db);
  await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  await admin.end();
});

dbIt("streams a fact over SSE and recovers it with the HTTP cursor", async () => {
  const activityId = await releasedActivity();
  const started = await post(`/api/activities/${activityId}/executions`, {
    scope: "stage",
    mode: "formal",
  });
  expect(started.status).toBe(201);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  let buffer = "";
  let lastId = 0;
  let found = false;
  try {
    const response = await fetch(
      `${baseUrl}/api/activities/${activityId}/stream?mode=formal&after=0`,
      { signal: controller.signal, headers: { accept: "text/event-stream" } },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    const decoder = new TextDecoder();
    while (reader !== undefined && !found) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const id = /^id: (\d+)$/m.exec(frame);
        const data = /^data: (.+)$/m.exec(frame);
        if (id !== null && data !== null) {
          lastId = Number(id[1]);
          const event = JSON.parse(data[1] ?? "{}") as { type: string };
          if (event.type === "ExecutionSessionStarted") {
            found = true;
            break;
          }
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
  expect(found).toBe(true);
  expect(lastId).toBeGreaterThan(0);

  // A disconnected client recovers the same fact from the cursor endpoint.
  const recovered = await fetch(
    `${baseUrl}/api/activities/${activityId}/events?mode=formal&after=${lastId}`,
  );
  const feed = (await recovered.json()) as {
    events: { sequence: number }[];
    headCursor: number;
  };
  expect(feed.events.every((event) => event.sequence > lastId)).toBe(true);
  expect(feed.headCursor).toBe(lastId);
});
