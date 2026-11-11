import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Client } from "pg";

import { closeDb, createDb, migrate } from "../src/index.js";
import { buildSchemaSnapshot, readSchemaRows } from "./schema-snapshot.js";

/**
 * Build the committed schema snapshot from the migrations alone. This is the
 * single source that `src/types.ts` is generated from: migrations describe the
 * schema, the snapshot makes it machine-readable, and the type file is derived.
 * Never edit `schema.snapshot.json` by hand.
 */
const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (connectionString === undefined || connectionString.trim() === "") {
  throw new Error("ARTFLOW_PLUS_DATABASE_URL is required (PostgreSQL).");
}

const schema = `artflow_schema_snapshot_${Date.now()}_${process.pid}`;
const output = fileURLToPath(new URL("../schema.snapshot.json", import.meta.url));

const admin = new Client({ connectionString });
await admin.connect();
await admin.query(`CREATE SCHEMA "${schema}"`);
try {
  const db = createDb({ connectionString, schema });
  await migrate(db);
  const snapshot = buildSchemaSnapshot(await readSchemaRows(db));
  writeFileSync(output, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  console.log(`Wrote ${snapshot.tables.length} tables to schema.snapshot.json.`);
  await closeDb(db);
} finally {
  await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await admin.end();
}
