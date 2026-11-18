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
  /**
   * Server-side safety nets. They are deliberately disabled for the short-lived
   * migration pool: a large index build must not be cancelled by a query budget
   * that exists to protect interactive traffic.
   */
  statementTimeoutMs?: number;
  lockTimeoutMs?: number;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

export function createDb(options: CreateDbOptions): Kysely<Database> {
  // A bounded connect timeout keeps readiness probes from hanging behind an
  // unreachable database; callers may override it explicitly.
  const {
    connectionString,
    schema,
    max = positiveInteger(process.env.ARTFLOW_PLUS_DB_POOL_MAX, 20),
    connectionTimeoutMillis = positiveInteger(process.env.ARTFLOW_PLUS_DB_CONNECT_TIMEOUT_MS, 10_000),
    statementTimeoutMs = nonNegativeInteger(process.env.ARTFLOW_PLUS_DB_STATEMENT_TIMEOUT_MS, 30_000),
    lockTimeoutMs = nonNegativeInteger(process.env.ARTFLOW_PLUS_DB_LOCK_TIMEOUT_MS, 15_000),
  } = options;
  if (schema !== undefined && !SAFE_SCHEMA.test(schema)) {
    throw new Error(`Unsafe schema name: ${schema}`);
  }
  const settings = [
    ...(schema === undefined ? [] : [`search_path=${schema}`]),
    `statement_timeout=${statementTimeoutMs}`,
    `lock_timeout=${lockTimeoutMs}`,
  ];
  const pool = new pg.Pool({
    connectionString,
    max,
    connectionTimeoutMillis,
    options: settings.map((setting) => `-c ${setting}`).join(" "),
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
