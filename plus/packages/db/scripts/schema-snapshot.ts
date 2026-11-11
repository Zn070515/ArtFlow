import { sql, type Kysely } from "kysely";

import type { Database } from "../src/index.js";

/**
 * Shared projection for the committed schema snapshot. Both the generator and
 * the schema-generation gate call these functions, so a change to the filter or
 * shape cannot drift between the artifact and the test that guards it.
 */
export interface SchemaColumnRow {
  readonly table_name: string;
  readonly column_name: string;
  readonly data_type: string;
  readonly is_nullable: string;
  readonly column_default: string | null;
  readonly is_identity: string;
}

export interface SchemaColumn {
  readonly name: string;
  readonly dataType: string;
  readonly nullable: boolean;
  readonly default: string | null;
  readonly identity: boolean;
}

export interface SchemaTable {
  readonly name: string;
  readonly columns: readonly SchemaColumn[];
}

export interface SchemaSnapshot {
  readonly version: 1;
  readonly source: string;
  readonly tables: readonly SchemaTable[];
}

export const SNAPSHOT_SOURCE = "packages/db/src/migrations";

export async function readSchemaRows(db: Kysely<Database>): Promise<readonly SchemaColumnRow[]> {
  const result = await sql<SchemaColumnRow>`
    select table_name, column_name, data_type, is_nullable, column_default, is_identity
      from information_schema.columns
     where table_schema = current_schema()
       and table_name not like 'kysely_%'
     order by table_name, ordinal_position
  `.execute(db);
  return result.rows;
}

export function buildSchemaSnapshot(rows: readonly SchemaColumnRow[]): SchemaSnapshot {
  const tables = new Map<string, SchemaColumn[]>();
  for (const row of rows) {
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
  return {
    version: 1,
    source: SNAPSHOT_SOURCE,
    tables: [...tables.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, columns]) => ({ name, columns })),
  };
}
