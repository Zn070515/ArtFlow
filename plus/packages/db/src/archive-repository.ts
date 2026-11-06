import type { ArchiveManifest, ArchiveSummary } from "@artflow-plus/domain";
import type { Kysely, Selectable } from "kysely";

import type { ArchivePackageRow, Database } from "./types.js";

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function json(value: unknown): unknown {
  return typeof value === "string" ? (JSON.parse(value) as unknown) : value;
}

export interface StoredArchivePackage {
  readonly id: string;
  readonly activityId: string;
  readonly version: number;
  readonly key: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly manifest: ArchiveManifest;
  readonly summary: ArchiveSummary;
  readonly note: string;
  readonly sealedAt: string;
  readonly sealedBy: string;
  readonly isCurrent: boolean;
}

function archivePackage(row: Selectable<ArchivePackageRow>): StoredArchivePackage {
  return {
    id: row.id,
    activityId: row.activity_id,
    version: row.version,
    key: row.key,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    manifest: json(row.manifest) as ArchiveManifest,
    summary: json(row.summary) as ArchiveSummary,
    note: row.note,
    sealedAt: iso(row.sealed_at) ?? "",
    sealedBy: row.sealed_by,
    isCurrent: row.is_current,
  };
}

export async function getCurrentArchivePackage(
  db: Kysely<Database>,
  activityId: string,
): Promise<StoredArchivePackage | null> {
  const row = await db.selectFrom("archive_package").selectAll()
    .where("activity_id", "=", activityId)
    .where("is_current", "=", true)
    .executeTakeFirst();
  return row === undefined ? null : archivePackage(row);
}

export async function getArchivePackage(
  db: Kysely<Database>,
  activityId: string,
  version: number,
): Promise<StoredArchivePackage | null> {
  const row = await db.selectFrom("archive_package").selectAll()
    .where("activity_id", "=", activityId)
    .where("version", "=", version)
    .executeTakeFirst();
  return row === undefined ? null : archivePackage(row);
}

export async function listArchivePackages(
  db: Kysely<Database>,
  activityId: string,
): Promise<readonly StoredArchivePackage[]> {
  const rows = await db.selectFrom("archive_package").selectAll()
    .where("activity_id", "=", activityId)
    .orderBy("version", "desc")
    .execute();
  return rows.map(archivePackage);
}

export async function maxArchiveVersion(
  db: Kysely<Database>,
  activityId: string,
): Promise<number> {
  const row = await db.selectFrom("archive_package")
    .select(({ fn }) => fn.max<number>("version").as("version"))
    .where("activity_id", "=", activityId)
    .executeTakeFirst();
  return Number(row?.version ?? 0);
}

export async function insertArchivePackage(
  db: Kysely<Database>,
  value: StoredArchivePackage,
): Promise<void> {
  await db.insertInto("archive_package").values({
    id: value.id,
    activity_id: value.activityId,
    version: value.version,
    key: value.key,
    size_bytes: value.sizeBytes,
    sha256: value.sha256,
    manifest: JSON.stringify(value.manifest),
    summary: JSON.stringify(value.summary),
    note: value.note,
    sealed_at: value.sealedAt,
    sealed_by: value.sealedBy,
    is_current: value.isCurrent,
  }).execute();
}

export async function demoteCurrentArchivePackages(
  db: Kysely<Database>,
  activityId: string,
): Promise<void> {
  await db.updateTable("archive_package")
    .set({ is_current: false })
    .where("activity_id", "=", activityId)
    .where("is_current", "=", true)
    .execute();
}
