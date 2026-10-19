import { sql, type Kysely } from "kysely";

import type { Database } from "./types.js";

const REQUIRED_MIGRATIONS = ["0002_execution_runtime", "0003_runtime_hardening"];

/**
 * Readiness is stronger than liveness: the process is only ready when the
 * required dependency (PostgreSQL) answers and the runtime schema is current.
 */
export async function checkReady(db: Kysely<Database>): Promise<void> {
  await sql`select 1`.execute(db);
  const result = await sql<{ name: string }>`
    select name from kysely_migration
  `.execute(db);
  const applied = new Set(result.rows.map((row) => row.name));
  const missing = REQUIRED_MIGRATIONS.filter((name) => !applied.has(name));
  if (missing.length > 0) {
    throw new Error(`Required migrations are not applied: ${missing.join(", ")}`);
  }
}
