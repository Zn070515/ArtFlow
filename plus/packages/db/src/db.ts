import { Kysely, PostgresDialect, type Transaction } from "kysely";
import pg from "pg";

import type { Database } from "./types.js";

const SAFE_SCHEMA = /^[a-z_][a-z0-9_]*$/;

export interface CreateDbOptions {
  connectionString: string;
  /** Test isolation: every connection starts with this search_path. */
  schema?: string;
  max?: number;
  /** Fail fast for readiness probes and broken hosts. */
  connectionTimeoutMillis?: number;
}

export function createDb(options: CreateDbOptions): Kysely<Database> {
  // A bounded connect timeout keeps readiness probes from hanging behind an
  // unreachable database; callers may override it explicitly.
  const {
    connectionString,
    schema,
    max = 5,
    connectionTimeoutMillis = 5_000,
  } = options;
  if (schema !== undefined && !SAFE_SCHEMA.test(schema)) {
    throw new Error(`Unsafe schema name: ${schema}`);
  }
  const pool = new pg.Pool({
    connectionString,
    max,
    connectionTimeoutMillis,
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
