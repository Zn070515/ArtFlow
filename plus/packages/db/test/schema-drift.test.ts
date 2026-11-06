import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { sql, type Kysely } from "kysely";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDb, createDb, migrate } from "../src/index.js";
import type { Database } from "../src/index.js";

/**
 * The Kysely `Database` interface and the hand-written migrations are two
 * descriptions of the same schema. TypeScript proves that queries match the
 * interface; it cannot prove that the interface matches PostgreSQL. This gate
 * migrates a disposable schema and compares tables, columns, and nullability
 * against `src/types.ts`.
 */

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_schema_drift_${Date.now()}_${process.pid}`;

const typesPath = fileURLToPath(new URL("../src/types.ts", import.meta.url));
const source = readFileSync(typesPath, "utf8");

interface ParsedSchema {
  readonly tables: ReadonlyMap<string, ReadonlyMap<string, string>>;
}

function splitTopLevel(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "<" || char === "(" || char === "[") depth += 1;
    else if (char === ">" || char === ")" || char === "]") depth -= 1;
    else if (char === "," && depth === 0) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(value.slice(start).trim());
  return parts;
}

function selectType(type: string): string {
  const trimmed = type.trim();
  const generated = /^Generated<([\s\S]+)>$/.exec(trimmed);
  if (generated?.[1] !== undefined) return generated[1].trim();
  const column = /^ColumnType<([\s\S]+)>$/.exec(trimmed);
  if (column?.[1] !== undefined) return splitTopLevel(column[1])[0] ?? "";
  return trimmed;
}

/**
 * `unknown` collapses any union with `null`, so the type cannot express
 * nullability. Treat it as indeterminate and rely on the column-presence check.
 */
function isNullable(type: string): boolean | null {
  const selected = selectType(type);
  if (/\bunknown\b/.test(selected)) return null;
  return /\bnull\b/.test(selected);
}

function parseSource(text: string): ParsedSchema {
  const interfaces = new Map<string, Map<string, string>>();
  const interfacePattern = /export interface (\w+) \{([\s\S]*?)\n\}/g;
  for (const match of text.matchAll(interfacePattern)) {
    const name = match[1];
    const body = match[2];
    if (name === undefined || body === undefined) continue;
    const columns = new Map<string, string>();
    for (const line of body.split("\n")) {
      const property = /^\s*(\w+)\s*:\s*(.+?);\s*$/.exec(line);
      if (property?.[1] !== undefined && property[2] !== undefined) {
        columns.set(property[1], property[2]);
      }
    }
    interfaces.set(name, columns);
  }

  const databaseMatch = /export interface Database \{([\s\S]*?)\n\}/.exec(text);
  if (databaseMatch?.[1] === undefined) {
    throw new Error("src/types.ts no longer declares a Database interface.");
  }
  const tables = new Map<string, ReadonlyMap<string, string>>();
  for (const line of databaseMatch[1].split("\n")) {
    const property = /^\s*(\w+)\s*:\s*(\w+);\s*$/.exec(line);
    if (property?.[1] === undefined || property[2] === undefined) continue;
    const columns = interfaces.get(property[2]);
    if (columns === undefined) {
      throw new Error(`Database.${property[1]} references unknown row type ${property[2]}.`);
    }
    tables.set(property[1], columns);
  }
  return { tables };
}

const expected = parseSource(source);

let db: Kysely<Database>;
let admin: Client;

describe.skipIf(!connectionString)("schema drift on PostgreSQL", () => {
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

  it("has the same tables as types.ts", async () => {
    const tables = await sql<{ table_name: string }>`
      select table_name
        from information_schema.tables
       where table_schema = current_schema()
         and table_type = 'BASE TABLE'
         and table_name not like 'kysely_%'
       order by table_name
    `.execute(db);
    const actual = tables.rows.map((row) => row.table_name).sort();
    const expectedTables = [...expected.tables.keys()].sort();
    expect(actual).toEqual(expectedTables);
  });

  it("has the same columns and nullability as types.ts", async () => {
    const columns = await sql<{
      table_name: string;
      column_name: string;
      is_nullable: string;
    }>`
      select table_name, column_name, is_nullable
        from information_schema.columns
       where table_schema = current_schema()
         and table_name not like 'kysely_%'
       order by table_name, ordinal_position
    `.execute(db);

    const actual = new Map<string, Map<string, boolean>>();
    for (const row of columns.rows) {
      const table = actual.get(row.table_name) ?? new Map<string, boolean>();
      table.set(row.column_name, row.is_nullable === "YES");
      actual.set(row.table_name, table);
    }

    const problems: string[] = [];
    for (const [table, expectedColumns] of expected.tables) {
      const actualColumns = actual.get(table);
      if (actualColumns === undefined) {
        problems.push(`${table}: table is missing from PostgreSQL`);
        continue;
      }
      const expectedNames = [...expectedColumns.keys()].sort();
      const actualNames = [...actualColumns.keys()].sort();
      if (expectedNames.join(",") !== actualNames.join(",")) {
        const missing = expectedNames.filter((name) => !actualColumns.has(name));
        const extra = actualNames.filter((name) => !expectedColumns.has(name));
        problems.push(
          `${table}: columns differ` +
            (missing.length > 0 ? `; missing in DB: ${missing.join(", ")}` : "") +
            (extra.length > 0 ? `; missing in types.ts: ${extra.join(", ")}` : ""),
        );
        continue;
      }
      for (const [column, type] of expectedColumns) {
        const expectedNullable = isNullable(type);
        if (expectedNullable === null) continue;
        const actualNullable = actualColumns.get(column) === true;
        if (expectedNullable !== actualNullable) {
          problems.push(
            `${table}.${column}: types.ts says ${expectedNullable ? "nullable" : "not null"}, ` +
              `PostgreSQL says ${actualNullable ? "nullable" : "not null"}`,
          );
        }
      }
    }
    expect(problems).toEqual([]);
  });
});
