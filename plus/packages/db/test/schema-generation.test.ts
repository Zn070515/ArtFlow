import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { sql, type Kysely } from "kysely";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDb, createDb, migrate } from "../src/index.js";
import type { Database } from "../src/index.js";

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
