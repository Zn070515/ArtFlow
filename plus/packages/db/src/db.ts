import { Kysely, PostgresDialect, type Transaction } from "kysely";
import pg from "pg";

import type { Database } from "./types.js";

const SAFE_SCHEMA = /^[a-z_][a-z0-9_]*$/;

export interface CreateDbOptions {
  connectionString: string;
  /** Test isolation: every connection starts with this search_path. */
  schema?: string;
  max?: number;
}

export function createDb(options: CreateDbOptions): Kysely<Database> {
  const { connectionString, schema, max = 5 } = options;
  if (schema !== undefined && !SAFE_SCHEMA.test(schema)) {
    throw new Error(`Unsafe schema name: ${schema}`);
  }
  const pool = new pg.Pool({
    connectionString,
    max,
    options: schema === undefined ? undefined : `-c search_path=${schema}`,
  });
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool }),
  });
}

/** One transaction helper; commands never open their own connection. */
export async function withTransaction<T>(
  db: Kysely<Database>,
  work: (trx: Transaction<Database>) => Promise<T>,
): Promise<T> {
  return db.transaction().execute(work);
}

export async function closeDb(db: Kysely<Database>): Promise<void> {
  await db.destroy();
}
