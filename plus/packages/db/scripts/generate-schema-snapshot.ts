import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { sql } from "kysely";
import { Client } from "pg";

import { closeDb, createDb, migrate } from "../src/index.js";

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
  const result = await sql<{
    table_name: string;
    column_name: string;
    data_type: string;
    is_nullable: string;
    column_default: string | null;
    is_identity: string;
  }>`
    select table_name, column_name, data_type, is_nullable, column_default, is_identity
      from information_schema.columns
     where table_schema = current_schema()
       and table_name not like 'kysely_%'
     order by table_name, ordinal_position
  `.execute(db);

  const tables = new Map<string, unknown[]>();
  for (const row of result.rows) {
    const list = tables.get(row.table_name) ?? [];
    list.push({
      name: row.column_name,
      dataType: row.data_type,
      nullable: row.is_nullable === "YES",
      default: row.column_default,
      identity: row.is_identity === "YES",
    });
    tables.set(row.table_name, list);
  }
  const snapshot = {
    version: 1,
    source: "packages/db/src/migrations",
    tables: [...tables.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, list]) => ({ name, columns: list })),
  };
  writeFileSync(output, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  console.log(`Wrote ${snapshot.tables.length} tables to schema.snapshot.json.`);
  await closeDb(db);
} finally {
  await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await admin.end();
}
