import { randomUUID } from "node:crypto";

import { closeDb, createDb, migrate } from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import type { Kysely } from "kysely";
import { Client } from "pg";

export interface ContractContext {
  readonly db: Kysely<Database>;
  /** A second connection for deterministic concurrency cases. */
  readonly dbB: Kysely<Database>;
  readonly admin: Client;
  readonly schema: string;
  dispose(): Promise<void>;
}

export function databaseUrl(): string | undefined {
  const value = process.env.ARTFLOW_PLUS_DATABASE_URL;
  if (process.env.REQUIRE_DB === "1" && (value === undefined || value.trim() === "")) {
    throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
  }
  return value;
}

/**
 * A disposable schema for contract tests. The contract suite must run against
 * real PostgreSQL; there is no in-memory substitute for receipt, transaction,
 * lock, and projection behavior.
 */
export async function createContractContext(): Promise<ContractContext> {
  const connectionString = databaseUrl();
  if (connectionString === undefined) {
    throw new Error("Contract tests require ARTFLOW_PLUS_DATABASE_URL.");
  }
  const schema = `artflow_contract_${Date.now()}_${process.pid}_${randomUUID().slice(0, 8)}`;
  const admin = new Client({ connectionString });
  await admin.connect();
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const db = createDb({ connectionString, schema });
  const dbB = createDb({ connectionString, schema });
  await migrate(db);
  return {
    db,
    dbB,
    admin,
    schema,
    async dispose(): Promise<void> {
      await closeDb(db);
      await closeDb(dbB);
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    },
  };
}
