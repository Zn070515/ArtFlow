import { sql, type Kysely } from "kysely";
import { Migrator, type Migration, type MigrationProvider, type MigrationResultSet } from "kysely/migration";

import { migration as m0001_activity_receipt_outbox } from "./migrations/0001_activity_receipt_outbox.js";
import { migration as m0002_execution_runtime } from "./migrations/0002_execution_runtime.js";
import { migration as m0003_runtime_hardening } from "./migrations/0003_runtime_hardening.js";
import { migration as m0004_local_sessions } from "./migrations/0004_local_sessions.js";
import { migration as m0005_registration_materials } from "./migrations/0005_registration_materials.js";
import { migration as m0006_competition_evaluation } from "./migrations/0006_competition_evaluation.js";
import { migration as m0007_score_correction_fingerprint } from "./migrations/0007_score_correction_fingerprint.js";
import { migration as m0008_resolution_candidates } from "./migrations/0008_resolution_candidates.js";
import { migration as m0009_m5_context_and_podium_metadata } from "./migrations/0009_m5_context_and_podium_metadata.js";
import { migration as m0010_m6_voting_ticketing } from "./migrations/0010_m6_voting_ticketing.js";
import { migration as m0011_voting_identity_policy } from "./migrations/0011_voting_identity_policy.js";
import { migration as m0012_m7_publishing } from "./migrations/0012_m7_publishing.js";
import { migration as m0013_m7_archive } from "./migrations/0013_m7_archive.js";
import { migration as m0014_stage_result_note } from "./migrations/0014_stage_result_note.js";
import { migration as m0015_mode_isolation } from "./migrations/0015_mode_isolation.js";
import { migration as m0016_grouping } from "./migrations/0016_grouping.js";
import { migration as m0017_result_provenance } from "./migrations/0017_result_provenance.js";
import { migration as m0018_material_cutover } from "./migrations/0018_material_cutover.js";
import { migration as m0019_participant_account_claim } from "./migrations/0019_participant_account_claim.js";
import { migration as m0020_participant_claim_reissue } from "./migrations/0020_participant_claim_reissue.js";
import { migration as m0021_rate_limit_buckets } from "./migrations/0021_rate_limit_buckets.js";
import { migration as m0022_tasks } from "./migrations/0022_tasks.js";
import { migration as m0023_drop_legacy_bridge } from "./migrations/0023_drop_legacy_bridge.js";
import { migration as m0024_attendance } from "./migrations/0024_attendance.js";

import type { Database } from "./types.js";

const migrations: Record<string, Migration> = {
  "0001_activity_receipt_outbox": m0001_activity_receipt_outbox,
  "0002_execution_runtime": m0002_execution_runtime,
  "0003_runtime_hardening": m0003_runtime_hardening,
  "0004_local_sessions": m0004_local_sessions,
  "0005_registration_materials": m0005_registration_materials,
  "0006_competition_evaluation": m0006_competition_evaluation,
  "0007_score_correction_fingerprint": m0007_score_correction_fingerprint,
  "0008_resolution_candidates": m0008_resolution_candidates,
  "0009_m5_context_and_podium_metadata": m0009_m5_context_and_podium_metadata,
  "0010_m6_voting_ticketing": m0010_m6_voting_ticketing,
  "0011_voting_identity_policy": m0011_voting_identity_policy,
  "0012_m7_publishing": m0012_m7_publishing,
  "0013_m7_archive": m0013_m7_archive,
  "0014_stage_result_note": m0014_stage_result_note,
  "0015_mode_isolation": m0015_mode_isolation,
  "0016_grouping": m0016_grouping,
  "0017_result_provenance": m0017_result_provenance,
  "0018_material_cutover": m0018_material_cutover,
  "0019_participant_account_claim": m0019_participant_account_claim,
  "0020_participant_claim_reissue": m0020_participant_claim_reissue,
  "0021_rate_limit_buckets": m0021_rate_limit_buckets,
  "0022_tasks": m0022_tasks,
  "0023_drop_legacy_bridge": m0023_drop_legacy_bridge,
  "0024_attendance": m0024_attendance,
};

class StaticMigrationProvider implements MigrationProvider {
  async getMigrations(): Promise<Record<string, Migration>> {
    return migrations;
  }
}

async function createMigrator(db: Kysely<Database>): Promise<Migrator> {
  // Kysely otherwise discovers migration tables in *any* schema; with pooled
  // search_path-based test schemas that can pick up another schema's lock
  // table. Pin the migrator to the connection's current schema.
  const current = await sql<{ schema: string }>`select current_schema() as schema`.execute(db);
  const schema = current.rows[0]?.schema;
  return new Migrator({
    db,
    provider: new StaticMigrationProvider(),
    ...(schema === undefined ? {} : { migrationTableSchema: schema }),
  });
}

export async function migrateTo(db: Kysely<Database>, migrationName: string): Promise<MigrationResultSet> {
  const migrator = await createMigrator(db);
  const result = await migrator.migrateTo(migrationName);
  if (result.error !== undefined) {
    throw result.error;
  }
  return result;
}

export async function migrate(db: Kysely<Database>): Promise<MigrationResultSet> {
  const migrator = await createMigrator(db);
  const result = await migrator.migrateToLatest();
  if (result.error !== undefined) {
    throw result.error;
  }
  return result;
}
