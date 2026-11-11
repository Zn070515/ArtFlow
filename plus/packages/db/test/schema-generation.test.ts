import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { Kysely } from "kysely";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDb, createDb, migrate } from "../src/index.js";
import type { Database } from "../src/index.js";
import { buildSchemaSnapshot, readSchemaRows } from "../scripts/schema-snapshot.js";

/**
 * Migrations are the single source of truth for the schema:
 *
 *   migrations -> schema.snapshot.json -> src/types.ts
 *
 * Both derived artifacts are committed. This gate regenerates the snapshot
 * from a disposable schema and checks that types.ts is byte-for-byte what the
 * generator produces, so neither can drift without failing CI.
 */
const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_schema_generation_${Date.now()}_${process.pid}`;
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const snapshotPath = fileURLToPath(new URL("../schema.snapshot.json", import.meta.url));

const committed = JSON.parse(readFileSync(snapshotPath, "utf8")) as unknown;

let db: Kysely<Database>;
let admin: Client;

describe.skipIf(!connectionString)("schema generation", () => {
  beforeAll(async () => {
    if (!connectionString) return;
    admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = createDb({ connectionString, schema });
    await migrate(db);
  });

  afterAll(async () => {
    if (!connectionString) return;
    await closeDb(db);
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });

  it("committed schema.snapshot.json matches the migrated schema", async () => {
    // Use the same projection as the generator: a second copy of the query
    // would let the script and this gate drift apart while staying green.
    const snapshot = buildSchemaSnapshot(await readSchemaRows(db));
    expect(snapshot).toEqual(committed);
  });

  it("src/types.ts is derived from the committed snapshot", () => {
    const output = execFileSync(process.execPath, ["scripts/generate-types.mjs", "--check"], {
      cwd: packageRoot,
      encoding: "utf8",
    });
    expect(output).toContain("matches schema.snapshot.json");
  });
});
