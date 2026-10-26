import { createHash } from "node:crypto";

import type {
  Database,
  SessionRecord,
  StoredArchivePackage,
  StoredResultRelease,
  StoredStageResult,
} from "@artflow-plus/db";
import {
  demoteCurrentArchivePackages,
  getActivityForUpdate,
  getArchivePackage,
  getCurrentArchivePackage,
  insertArchivePackage,
  listActiveResultReleases,
  listArchivePackages,
  listResultReleases,
  listRoundsForActivity,
  listStageResults,
  listUnsettledCorrectionsForActivity,
  listVoteSessionsForActivity,
  maxArchiveVersion,
  readEventsSince,
  updateActivity,
  listSessionRecords,
} from "@artflow-plus/db";
import {
  archiveActivity as archiveActivityDomain,
  DomainError,
  requirePermission,
  unarchiveActivity as unarchiveActivityDomain,
} from "@artflow-plus/domain";
import type { Activity, ArchiveSummary } from "@artflow-plus/domain";
import type { Kysely } from "kysely";

import { buildArchivePackage } from "./archive-package.js";
import type { ArchiveStorage, StoredArchiveFile } from "./archive-storage.js";
import { executeCommand, type CommandOutcome } from "./command.js";
import { runtimeActor, type RuntimeDeps } from "./deps.js";
import { appendEngineEvent } from "./events.js";
import { idFromCommand } from "./hash.js";

function requireCapability(activity: Activity, key: string): void {
  if (!activity.enabledCapabilities.includes(key)) {
    throw new DomainError("CAPABILITY_NOT_ENABLED", `Capability ${key} is not enabled on this activity.`);
  }
}

function requireStorage(deps: RuntimeDeps): ArchiveStorage {
  if (deps.archiveStorage === undefined) {
    throw new DomainError("INVALID_INPUT", "Archive storage is not configured.");
  }
  return deps.archiveStorage;
}

async function requireArchiveClosure(
  trx: Kysely<Database>,
  activity: Activity,
  sessions: readonly SessionRecord[],
): Promise<void> {
  if (sessions.some((session) => session.status === "running")) {
    throw new DomainError("ACTIVITY_HAS_RUNNING_SESSIONS", "Close every execution session before archiving.");
  }
  if (activity.enabledCapabilities.includes("publishing")) {
    const active = await listActiveResultReleases(trx, activity.id);
    if (active.length === 0) {
      throw new DomainError("ARCHIVE_RESULT_NOT_RELEASED", "Publish at least one active result release before archiving.");
    }
  }
  if (activity.enabledCapabilities.includes("competition")) {
    const rounds = await listRoundsForActivity(trx, activity.id);
    if (rounds.some((round) => round.state !== "locked")) {
      throw new DomainError("ARCHIVE_ROUND_NOT_LOCKED", "Lock every competition round before archiving.");
    }
    const corrections = await listUnsettledCorrectionsForActivity(trx, activity.id);
    if (corrections.length > 0) {
      throw new DomainError("ARCHIVE_CORRECTION_OPEN", "Finish every score correction before archiving.");
    }
  }
  if (activity.enabledCapabilities.includes("voting")) {
    const voteSessions = await listVoteSessionsForActivity(trx, activity.id);
    if (voteSessions.some((session) => session.status !== "closed")) {
      throw new DomainError("ARCHIVE_VOTE_SESSION_OPEN", "Close every vote session before archiving.");
    }
  }
}

export interface ArchiveActivityInput {
  readonly commandId: string;
  readonly activityId: string;
  readonly expectedRevision: number;
  readonly note: string;
}

export interface ArchiveActivityResult {
  readonly package: StoredArchivePackage;
  readonly summary: ArchiveSummary;
}

export async function archiveActivity(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: ArchiveActivityInput,
): Promise<CommandOutcome<ArchiveActivityResult>> {
  const actor = runtimeActor(deps);
  const storage = requireStorage(deps);
  const note = input.note.trim();
  if (!note) throw new DomainError("INVALID_INPUT", "An archive note is required.");
  let written: StoredArchiveFile | null = null;
  try {
    return await executeCommand(db, {
      commandId: input.commandId,
      activityId: input.activityId,
      capability: "archive",
      commandType: "archive.activity.archive",
      actor,
      payload: { expectedRevision: input.expectedRevision, note },
    }, async (trx) => {
      requirePermission(actor, "archive.manage");
      const activity = await getActivityForUpdate(trx, input.activityId);
      if (activity === null) throw new DomainError("NOT_FOUND", "The activity was not found.");
      requireCapability(activity, "archive");
      if (activity.status === "archived") {
        throw new DomainError("ACTIVITY_ARCHIVED", "The activity is already archived.");
      }
      if (activity.revision !== input.expectedRevision) {
        throw new DomainError("STALE_REVISION", "The activity changed since it was read.");
      }
      if (activity.status !== "closed") {
        throw new DomainError("INVALID_TRANSITION", "Only a closed activity can be archived.");
      }
      const sessions = await listSessionRecords(trx, activity.id);
      await requireArchiveClosure(trx, activity, sessions);

      const publicCodeRow = await trx.selectFrom("activity")
        .select("public_code")
        .where("id", "=", activity.id)
        .executeTakeFirst();
      const version = (await maxArchiveVersion(trx, activity.id)) + 1;
      const archivedAt = deps.now();
      const packageId = idFromCommand("archive", input.commandId);
      const releases: readonly StoredResultRelease[] = await listResultReleases(trx, activity.id);
      const stageResults: readonly StoredStageResult[] = await listStageResults(trx, activity.id);
      const events = await readEventsSince(trx, {
        activityId: activity.id,
        after: 0,
        limit: 100_000,
        mode: "formal",
      });
      const built = buildArchivePackage({
        packageId,
        version,
        activity: {
          id: activity.id,
          publicCode: publicCodeRow?.public_code ?? activity.id,
          title: activity.title,
          enabledCapabilities: activity.enabledCapabilities,
          activeDefinitionVersion: activity.activeDefinitionVersion,
        },
        releases,
        stageResults,
        sessions,
        events,
        archivedAt,
        archivedBy: actor.actorId,
      });
      written = await storage.put(`${activity.id}/v${version}.zip`, built.bytes);
      await demoteCurrentArchivePackages(trx, activity.id);
      const stored: StoredArchivePackage = {
        id: packageId,
        activityId: activity.id,
        version,
        key: written.key,
        sizeBytes: written.size,
        sha256: written.sha256,
        manifest: built.manifest,
        summary: built.summary,
        note,
        sealedAt: archivedAt,
        sealedBy: actor.actorId,
        isCurrent: true,
      };
      await insertArchivePackage(trx, stored);
      const next = archiveActivityDomain(activity, activity.revision);
      const saved = await updateActivity(trx, next, activity.revision);
      await appendEngineEvent(trx, deps, {
        type: "ArchivePackaged",
        activityId: saved.id,
        aggregateType: "archive_package",
        aggregateId: stored.id,
        revision: stored.version,
        capability: "archive",
        payload: {
          packageId: stored.id,
          version: stored.version,
          sha256: stored.sha256,
          sizeBytes: stored.sizeBytes,
          artifactCount: stored.manifest.artifacts.length,
        },
      });
      await appendEngineEvent(trx, deps, {
        type: "ActivityArchived",
        activityId: saved.id,
        aggregateType: "activity",
        aggregateId: saved.id,
        revision: saved.revision,
        payload: { activityId: saved.id, packageId: stored.id },
      });
      return { body: { package: stored, summary: built.summary }, status: 201 };
    });
  } catch (error) {
    const cleanup = written as StoredArchiveFile | null;
    if (cleanup !== null) await storage.remove(cleanup.key).catch(() => undefined);
    throw error;
  }
}

export interface UnarchiveActivityInput {
  readonly commandId: string;
  readonly activityId: string;
  readonly expectedRevision: number;
  readonly note: string;
}

export interface UnarchiveActivityResult {
  readonly activity: Activity;
  readonly demotedPackageId: string | null;
}

export async function unarchiveActivity(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: UnarchiveActivityInput,
): Promise<CommandOutcome<UnarchiveActivityResult>> {
  const actor = runtimeActor(deps);
  const note = input.note.trim();
  if (!note) throw new DomainError("INVALID_INPUT", "An unarchive note is required.");
  return executeCommand(db, {
    commandId: input.commandId,
    activityId: input.activityId,
    capability: "archive",
    commandType: "archive.activity.unarchive",
    actor,
    payload: { expectedRevision: input.expectedRevision, note },
  }, async (trx) => {
    requirePermission(actor, "archive.manage");
    const activity = await getActivityForUpdate(trx, input.activityId);
    if (activity === null) throw new DomainError("NOT_FOUND", "The activity was not found.");
    requireCapability(activity, "archive");
    if (activity.revision !== input.expectedRevision) {
      throw new DomainError("STALE_REVISION", "The activity changed since it was read.");
    }
    if (activity.status !== "archived") {
      throw new DomainError("INVALID_TRANSITION", "Only an archived activity can be unarchived.");
    }
    const current = await getCurrentArchivePackage(trx, activity.id);
    if (current !== null) await demoteCurrentArchivePackages(trx, activity.id);
    const next = unarchiveActivityDomain(activity, activity.revision);
    const saved = await updateActivity(trx, next, activity.revision);
    await appendEngineEvent(trx, deps, {
      type: "ActivityUnarchived",
      activityId: saved.id,
      aggregateType: "activity",
      aggregateId: saved.id,
      revision: saved.revision,
      payload: { activityId: saved.id, demotedPackageId: current?.id ?? null, note },
    });
    return { body: { activity: saved, demotedPackageId: current?.id ?? null } };
  });
}

export interface ArchiveState {
  readonly activity: { readonly id: string; readonly title: string; readonly status: string };
  readonly packages: readonly Omit<StoredArchivePackage, "key">[];
}

export async function getArchiveState(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: { readonly activityId: string },
): Promise<ArchiveState> {
  requirePermission(runtimeActor(deps), "archive.manage");
  const activity = await db.selectFrom("activity")
    .select(["id", "title", "status"])
    .where("id", "=", input.activityId)
    .executeTakeFirst();
  if (activity === undefined) throw new DomainError("NOT_FOUND", "The activity was not found.");
  const packages = await listArchivePackages(db, input.activityId);
  return {
    activity: { id: activity.id, title: activity.title, status: activity.status },
    packages: packages.map((item) => ({
      id: item.id,
      activityId: item.activityId,
      version: item.version,
      sizeBytes: item.sizeBytes,
      sha256: item.sha256,
      manifest: item.manifest,
      summary: item.summary,
      note: item.note,
      sealedAt: item.sealedAt,
      sealedBy: item.sealedBy,
      isCurrent: item.isCurrent,
    })),
  };
}

export interface ArchiveFile {
  readonly bytes: Uint8Array;
  readonly filename: string;
}

export async function readArchiveFile(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: { readonly activityId: string; readonly version?: number },
): Promise<ArchiveFile> {
  requirePermission(runtimeActor(deps), "archive.manage");
  const storage = requireStorage(deps);
  const stored = input.version === undefined
    ? await getCurrentArchivePackage(db, input.activityId)
    : await getArchivePackage(db, input.activityId, input.version);
  if (stored === null) throw new DomainError("ARCHIVE_NOT_FOUND", "The archive package was not found.");
  let bytes: Uint8Array;
  try {
    bytes = await storage.read(stored.key);
  } catch {
    throw new DomainError("ARCHIVE_INTEGRITY_FAILED", "The archive package file is missing or unreadable.");
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (bytes.byteLength !== stored.sizeBytes || digest !== stored.sha256) {
    throw new DomainError("ARCHIVE_INTEGRITY_FAILED", "The archive package failed its integrity check.");
  }
  return { bytes, filename: `archive-${input.activityId}-v${stored.version}.zip` };
}
