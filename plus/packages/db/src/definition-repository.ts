import type {
  ActivityDefinitionPackage,
  CapabilityBinding,
  CompiledCapabilityPlan,
  ExecutionPolicy,
} from "@artflow-plus/domain";
import type { Kysely, Selectable } from "kysely";

import { StaleRevisionError } from "./activity-repository.js";
import type { Database, DefinitionReleaseRow } from "./types.js";

export interface StoredDraft {
  readonly activityId: string;
  readonly revision: number;
  readonly package: ActivityDefinitionPackage;
}

export interface StoredCompiled {
  readonly activityId: string;
  readonly draftRevision: number;
  readonly contentHash: string;
  readonly capabilities: Readonly<Record<string, CompiledCapabilityPlan>>;
}

export interface StoredRelease {
  readonly activityId: string;
  readonly version: number;
  readonly contentHash: string;
  readonly capabilities: Readonly<Record<string, CompiledCapabilityPlan>>;
  readonly executionPolicy: ExecutionPolicy;
  readonly capabilityVersions: Readonly<Record<string, string>>;
  readonly bindings: readonly CapabilityBinding[];
  readonly releasedAt: string;
  readonly sourceDraftRevision: number;
}

function parsePackage(value: unknown): ActivityDefinitionPackage {
  return value as ActivityDefinitionPackage;
}

function parseCapabilities(
  value: unknown,
): Readonly<Record<string, CompiledCapabilityPlan>> {
  return value as Readonly<Record<string, CompiledCapabilityPlan>>;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

export async function getDraft(
  db: Kysely<Database>,
  activityId: string,
): Promise<StoredDraft | null> {
  const row = await db
    .selectFrom("definition_draft")
    .selectAll()
    .where("activity_id", "=", activityId)
    .executeTakeFirst();
  if (row === undefined) return null;
  return {
    activityId: row.activity_id,
    revision: row.revision,
    package: parsePackage(row.package),
  };
}

export async function insertDraft(
  trx: Kysely<Database>,
  draft: StoredDraft,
): Promise<void> {
  await trx
    .insertInto("definition_draft")
    .values({
      activity_id: draft.activityId,
      revision: draft.revision,
      package: JSON.stringify(draft.package),
      updated_at: new Date(),
    })
    .execute();
}

/** Compare-and-swap on the draft revision; a stale editor never overwrites. */
export async function updateDraft(
  trx: Kysely<Database>,
  draft: StoredDraft,
  expectedRevision: number,
): Promise<StoredDraft> {
  const row = await trx
    .updateTable("definition_draft")
    .set({
      revision: draft.revision,
      package: JSON.stringify(draft.package),
      updated_at: new Date(),
    })
    .where("activity_id", "=", draft.activityId)
    .where("revision", "=", expectedRevision)
    .returningAll()
    .executeTakeFirst();
  if (row === undefined) {
    throw new StaleRevisionError(draft.activityId);
  }
  return {
    activityId: row.activity_id,
    revision: row.revision,
    package: parsePackage(row.package),
  };
}

export async function insertCompiled(
  trx: Kysely<Database>,
  compiled: StoredCompiled,
): Promise<void> {
  await trx
    .insertInto("definition_compiled")
    .values({
      activity_id: compiled.activityId,
      draft_revision: compiled.draftRevision,
      content_hash: compiled.contentHash,
      capabilities: JSON.stringify(compiled.capabilities),
      compiled_at: new Date(),
    })
    .onConflict((conflict) =>
      conflict.columns(["activity_id", "draft_revision"]).doNothing(),
    )
    .execute();
}

export async function getCompiled(
  db: Kysely<Database>,
  activityId: string,
  draftRevision: number,
): Promise<StoredCompiled | null> {
  const row = await db
    .selectFrom("definition_compiled")
    .selectAll()
    .where("activity_id", "=", activityId)
    .where("draft_revision", "=", draftRevision)
    .executeTakeFirst();
  if (row === undefined) return null;
  return {
    activityId: row.activity_id,
    draftRevision: row.draft_revision,
    contentHash: row.content_hash,
    capabilities: parseCapabilities(row.capabilities),
  };
}

function rowToRelease(row: Selectable<DefinitionReleaseRow>): StoredRelease {
  return {
    activityId: row.activity_id,
    version: row.version,
    contentHash: row.content_hash,
    capabilities: parseCapabilities(row.capabilities),
    executionPolicy: row.execution_policy as ExecutionPolicy,
    capabilityVersions: row.capability_versions as Readonly<Record<string, string>>,
    bindings: row.bindings as readonly CapabilityBinding[],
    releasedAt: toIso(row.released_at),
    sourceDraftRevision: row.source_draft_revision,
  };
}

export async function insertRelease(
  trx: Kysely<Database>,
  release: StoredRelease,
): Promise<void> {
  await trx
    .insertInto("definition_release")
    .values({
      activity_id: release.activityId,
      version: release.version,
      content_hash: release.contentHash,
      capabilities: JSON.stringify(release.capabilities),
      execution_policy: JSON.stringify(release.executionPolicy),
      capability_versions: JSON.stringify(release.capabilityVersions),
      bindings: JSON.stringify(release.bindings),
      released_at: release.releasedAt,
      source_draft_revision: release.sourceDraftRevision,
    })
    .execute();
}

export async function listReleases(
  db: Kysely<Database>,
  activityId: string,
): Promise<readonly StoredRelease[]> {
  const rows = await db
    .selectFrom("definition_release")
    .selectAll()
    .where("activity_id", "=", activityId)
    .orderBy("version", "desc")
    .execute();
  return rows.map(rowToRelease);
}

export async function getRelease(
  db: Kysely<Database>,
  activityId: string,
  version: number,
): Promise<StoredRelease | null> {
  const row = await db
    .selectFrom("definition_release")
    .selectAll()
    .where("activity_id", "=", activityId)
    .where("version", "=", version)
    .executeTakeFirst();
  return row === undefined ? null : rowToRelease(row);
}

export async function findReleaseByQuestionnaireHash(
  db: Kysely<Database>,
  activityId: string,
  questionnaireHash: string,
): Promise<StoredRelease | null> {
  const rows = await db
    .selectFrom("definition_release")
    .selectAll()
    .where("activity_id", "=", activityId)
    .orderBy("version", "desc")
    .execute();
  for (const row of rows) {
    const release = rowToRelease(row);
    const plan = release.capabilities.questionnaire;
    if (plan?.ok !== true || typeof plan.artifact !== "object" || plan.artifact === null) continue;
    const artifact = plan.artifact as { readonly schemaHash?: unknown };
    if (artifact.schemaHash === questionnaireHash) return release;
  }
  return null;
}

export async function getLatestRelease(
  db: Kysely<Database>,
  activityId: string,
): Promise<StoredRelease | null> {
  const row = await db
    .selectFrom("definition_release")
    .selectAll()
    .where("activity_id", "=", activityId)
    .orderBy("version", "desc")
    .limit(1)
    .executeTakeFirst();
  return row === undefined ? null : rowToRelease(row);
}
