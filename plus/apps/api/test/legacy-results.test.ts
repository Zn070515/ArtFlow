import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { closeDb, createDb, migrate } from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import { importLegacyBundle, type RuntimeDeps } from "@artflow-plus/runtime";
import type { FastifyInstance } from "fastify";
import { Client } from "pg";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_api_legacy_results_${Date.now()}_${process.pid}`;
const bundle = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../../packages/runtime/test/fixtures/legacy-bundle.json", import.meta.url)),
    "utf8",
  ),
) as Record<string, unknown>;

let db: Kysely<Database>;
let admin: Client;
let app: FastifyInstance;
const deps: RuntimeDeps = {
  now: () => new Date().toISOString(),
  newEventId: () => randomUUID(),
};

describe.skipIf(!connectionString)("legacy published results", () => {
  beforeAll(async () => {
    if (!connectionString) return;
    admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = createDb({ connectionString, schema });
    await migrate(db);
    app = await buildApp({ db, deps });
    await app.ready();
    await importLegacyBundle(db, deps, {
      commandId: "legacy-results-import",
      bundle,
      dryRun: false,
    });
  });

  afterAll(async () => {
    if (!connectionString) return;
    await app.close();
    await closeDb(db);
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });

  it("serves the imported v1 snapshot through the public results selector", async () => {
    const response = await app.inject({ method: "GET", url: "/api/public/results/LEG-1" });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      activity: { publicCode: "LEG-1" },
      activityTitle: "2025 院十佳",
      results: [
        {
          stageKey: "final_podium",
          publicTitle: "2025 院十佳 · 正式赛果",
          decisions: [{ rank: 1, contestantId: "legacy-user:1", score: "91.50" }],
          awards: [{ award: "冠军", contestantId: "legacy-user:1" }],
        },
      ],
    });
  });
});
