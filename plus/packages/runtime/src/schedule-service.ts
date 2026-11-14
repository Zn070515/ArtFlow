import type { Database } from "@artflow-plus/db";
import {
  StaleRevisionError,
  deleteScheduleEntry,
  getActivityForUpdate,
  getActivitySummary,
  getRelease,
  getScheduleCurrent,
  getScheduleEntryForUpdate,
  getScheduleStateRevision,
  insertScheduleEntry,
  insertScheduleRelease,
  updateScheduleEntry,
  listScheduleEntries,
  listScheduleReleases,
  reorderScheduleEntries,
  revokeScheduleRelease,
  selectActiveScheduleRelease,
  setScheduleCurrent,
  ensureScheduleState,
  bumpScheduleState,
} from "@artflow-plus/db";
import type {
  ScheduleMode,
  ScheduleSnapshotEntry,
  StoredScheduleEntry,
  StoredScheduleRelease,
} from "@artflow-plus/db";
import type { CompiledScheduleArtifact, ActorContext } from "@artflow-plus/domain";
import { DomainError, requirePermission } from "@artflow-plus/domain";
import type { Kysely } from "kysely";

import { executeCommand, type CommandOutcome } from "./command.js";
import { runtimeActor, type RuntimeDeps } from "./deps.js";
import { appendEngineEvent } from "./events.js";
import { idFromCommand } from "./hash.js";
import { requireRunningCommandSession } from "./command-scope.js";

const MODES: readonly ScheduleMode[] = ["test", "rehearsal", "formal"];

export interface ScheduleEntryView extends StoredScheduleEntry {
  readonly slotLabel: string;
}

export interface ScheduleView {
  readonly revision: number;
  readonly entries: readonly ScheduleEntryView[];
  readonly releases: readonly StoredScheduleRelease[];
  readonly currentEntryId: string | null;
  readonly slots: readonly CompiledScheduleArtifact["slots"][number][];
}

export interface PublicScheduleView {
  readonly activity: { readonly publicCode: string; readonly title: string };
  readonly entries: readonly ScheduleSnapshotEntry[];
}

function requireActive(activity: { readonly status: string }): void {
  if (activity.status !== "active") {
    throw new DomainError("ACTIVITY_NOT_ACTIVE", "Schedule commands require an active activity.");
  }
}

function requireMode(mode: string): ScheduleMode {
  if (!MODES.includes(mode as ScheduleMode)) {
    throw new DomainError("INVALID_INPUT", "mode must be test, rehearsal, or formal.");
  }
  return mode as ScheduleMode;
}

function requireText(value: string, field: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > max) {
    throw new DomainError("INVALID_INPUT", `${field} must be 1-${max} characters.`);
  }
  return trimmed;
}

async function requireScheduleArtifact(
  trx: Kysely<Database>,
  activity: { readonly id: string; readonly activeDefinitionVersion: number },
): Promise<CompiledScheduleArtifact> {
  const release = await getRelease(trx, activity.id, activity.activeDefinitionVersion);
  const plan = release?.capabilities.schedule;
  if (plan === undefined || plan.ok !== true) {
    throw new DomainError("SCHEDULE_NOT_ENABLED", "The active release does not include schedule.");
  }
  return plan.artifact as CompiledScheduleArtifact;
}

function requireSlot(artifact: CompiledScheduleArtifact, slotKey: string): void {
  if (!artifact.slots.some((slot) => slot.key === slotKey)) {
    throw new DomainError("SLOT_UNKNOWN", `Slot ${slotKey} is not part of the schedule definition.`);
  }
}

async function staleSafe<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof StaleRevisionError) {
      throw new DomainError("STALE_REVISION", "The schedule changed; refresh and retry.");
    }
    throw error;
  }
}

function requireManager(actor: ActorContext): void {
  requirePermission(actor, "schedule.manage");
}

export async function getScheduleState(
  db: Kysely<Database>,
  activityId: string,
  mode: string,
): Promise<ScheduleView> {
  const normalized = requireMode(mode);
  const [revision, rows, releases, currentEntryId, activity] = await Promise.all([
    getScheduleStateRevision(db, activityId, normalized),
    listScheduleEntries(db, activityId, normalized),
    listScheduleReleases(db, activityId, normalized),
    getScheduleCurrent(db, activityId, normalized),
    getActivitySummary(db, activityId),
  ]);
  const release = activity === null
    ? null
    : await getRelease(db, activityId, activity.activeDefinitionVersion);
  const plan = release?.capabilities.schedule;
  const slots = plan !== undefined && plan.ok === true
    ? (plan.artifact as CompiledScheduleArtifact).slots
    : [];
  const labels = new Map(slots.map((slot) => [slot.key, slot.label]));
  const entries = rows.map((entry) => ({
    ...entry,
    slotLabel: labels.get(entry.slotKey) ?? entry.slotKey,
  }));
  return { revision, entries, releases, currentEntryId, slots };
}

export async function getPublicSchedule(
  db: Kysely<Database>,
  publicCode: string,
): Promise<PublicScheduleView | null> {
  const active = await selectActiveScheduleRelease(db, publicCode);
  if (active === null) return null;
  return {
    activity: { publicCode: active.publicCode, title: active.activityTitle },
    entries: active.release.snapshot.entries,
  };
}

export interface UpsertScheduleEntryInput {
  readonly commandId: string;
  readonly activityId: string;
  readonly mode: string;
  readonly expectedRevision: number;
  readonly entryId?: string;
  readonly slotKey: string;
  readonly participantId?: string | null;
  readonly title: string;
  readonly note?: string;
  readonly position?: number;
}

export interface UpsertScheduleEntryBody {
  readonly entry: StoredScheduleEntry;
  readonly revision: number;
}

export async function upsertScheduleEntry(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: UpsertScheduleEntryInput,
): Promise<CommandOutcome<UpsertScheduleEntryBody>> {
  const actor = runtimeActor(deps);
  const mode = requireMode(input.mode);
  return executeCommand(
    db,
    {
      commandId: input.commandId,
      activityId: input.activityId,
      capability: "schedule",
      commandType: "schedule.entry.upsert",
      actor,
      payload: {
        mode,
        entryId: input.entryId ?? null,
        slotKey: input.slotKey,
        participantId: input.participantId ?? null,
        title: input.title,
        note: input.note ?? "",
        position: input.position ?? null,
      },
    },
    async (trx) => {
      requireManager(actor);
      const activity = await getActivityForUpdate(trx, input.activityId);
      if (activity === null) throw new DomainError("NOT_FOUND", "The activity was not found.");
      requireActive(activity);
      const artifact = await requireScheduleArtifact(trx, activity);
      requireSlot(artifact, input.slotKey);
      await ensureScheduleState(trx, activity.id, mode);
      const entries = await listScheduleEntries(trx, activity.id, mode);
      const title = requireText(input.title, "title", 200);
      const note = input.note?.slice(0, 500) ?? "";

      let current: StoredScheduleEntry;
      if (input.entryId === undefined) {
        current = {
          id: idFromCommand("schedule-entry", `${activity.id}:${mode}:${input.commandId}`),
          activityId: activity.id,
          mode,
          position: input.position ?? entries.length,
          slotKey: input.slotKey,
          participantId: input.participantId ?? null,
          title,
          note,
          revision: 0,
          createdAt: deps.now(),
          updatedAt: deps.now(),
        };
        current = await insertScheduleEntry(trx, current);
      } else {
        const existing = await getScheduleEntryForUpdate(trx, input.entryId);
        if (existing === null || existing.activityId !== activity.id || existing.mode !== mode) {
          throw new DomainError("NOT_FOUND", "The schedule entry was not found.");
        }
        current = await updateScheduleEntry(trx, {
          ...existing,
          position: input.position ?? existing.position,
          slotKey: input.slotKey,
          participantId: input.participantId ?? null,
          title,
          note,
        }, existing.revision);
      }
      const revision = await staleSafe(() => bumpScheduleState(trx, activity.id, mode, input.expectedRevision));
      await appendEngineEvent(trx, deps, {
        type: "ScheduleEntryChanged",
        activityId: activity.id,
        aggregateType: "schedule_entry",
        aggregateId: current.id,
        revision,
        mode,
        scope: "schedule",
        capability: "schedule",
        payload: { entry: current, mode },
      });
      return { body: { entry: current, revision }, status: 201 };
    },
  );
}

export interface ReorderScheduleInput {
  readonly commandId: string;
  readonly activityId: string;
  readonly mode: string;
  readonly expectedRevision: number;
  readonly orderedIds: readonly string[];
}

export async function reorderSchedule(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: ReorderScheduleInput,
): Promise<CommandOutcome<ScheduleView>> {
  const actor = runtimeActor(deps);
  const mode = requireMode(input.mode);
  return executeCommand(
    db,
    {
      commandId: input.commandId,
      activityId: input.activityId,
      capability: "schedule",
      commandType: "schedule.entry.reorder",
      actor,
      payload: { mode, orderedIds: input.orderedIds },
    },
    async (trx) => {
      requireManager(actor);
      const activity = await getActivityForUpdate(trx, input.activityId);
      if (activity === null) throw new DomainError("NOT_FOUND", "The activity was not found.");
      requireActive(activity);
      const artifact = await requireScheduleArtifact(trx, activity);
      const entries = await listScheduleEntries(trx, activity.id, mode);
      const ids = new Set(entries.map((entry) => entry.id));
      if (
        input.orderedIds.length !== entries.length ||
        new Set(input.orderedIds).size !== input.orderedIds.length ||
        input.orderedIds.some((id) => !ids.has(id))
      ) {
        throw new DomainError("INVALID_INPUT", "orderedIds must contain every schedule entry exactly once.");
      }
      const revision = await staleSafe(() => bumpScheduleState(trx, activity.id, mode, input.expectedRevision));
      await reorderScheduleEntries(trx, activity.id, mode, input.orderedIds);
      await appendEngineEvent(trx, deps, {
        type: "ScheduleReordered",
        activityId: activity.id,
        aggregateType: "schedule",
        aggregateId: `${activity.id}:${mode}`,
        revision,
        mode,
        scope: "schedule",
        capability: "schedule",
        payload: { orderedIds: input.orderedIds, mode },
      });
      const view = await getScheduleState(trx, activity.id, mode);
      return { body: { ...view, revision } };
    },
  );
}

export interface RemoveScheduleEntryInput {
  readonly commandId: string;
  readonly activityId: string;
  readonly mode: string;
  readonly expectedRevision: number;
  readonly entryId: string;
}

export async function removeScheduleEntry(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: RemoveScheduleEntryInput,
): Promise<CommandOutcome<{ readonly revision: number }>> {
  const actor = runtimeActor(deps);
  const mode = requireMode(input.mode);
  return executeCommand(
    db,
    {
      commandId: input.commandId,
      activityId: input.activityId,
      capability: "schedule",
      commandType: "schedule.entry.remove",
      actor,
      payload: { mode, entryId: input.entryId },
    },
    async (trx) => {
      requireManager(actor);
      const activity = await getActivityForUpdate(trx, input.activityId);
      if (activity === null) throw new DomainError("NOT_FOUND", "The activity was not found.");
      requireActive(activity);
      const entry = await getScheduleEntryForUpdate(trx, input.entryId);
      if (entry === null || entry.activityId !== activity.id || entry.mode !== mode) {
        throw new DomainError("NOT_FOUND", "The schedule entry was not found.");
      }
      const revision = await staleSafe(() => bumpScheduleState(trx, activity.id, mode, input.expectedRevision));
      const deleted = await deleteScheduleEntry(trx, entry.id, entry.revision);
      if (!deleted) throw new DomainError("STALE_REVISION", "The schedule entry changed; refresh and retry.");
      await appendEngineEvent(trx, deps, {
        type: "ScheduleEntryChanged",
        activityId: activity.id,
        aggregateType: "schedule_entry",
        aggregateId: entry.id,
        revision,
        mode,
        scope: "schedule",
        capability: "schedule",
        payload: { removed: entry.id, mode },
      });
      return { body: { revision } };
    },
  );
}

export interface ReleaseScheduleInput {
  readonly commandId: string;
  readonly activityId: string;
  readonly mode: string;
  readonly expectedRevision: number;
  readonly note?: string;
}

export async function releaseSchedule(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: ReleaseScheduleInput,
): Promise<CommandOutcome<StoredScheduleRelease>> {
  const actor = runtimeActor(deps);
  const mode = requireMode(input.mode);
  return executeCommand(
    db,
    {
      commandId: input.commandId,
      activityId: input.activityId,
      capability: "schedule",
      commandType: "schedule.release",
      actor,
      payload: { mode, note: input.note ?? "" },
    },
    async (trx) => {
      requireManager(actor);
      const activity = await getActivityForUpdate(trx, input.activityId);
      if (activity === null) throw new DomainError("NOT_FOUND", "The activity was not found.");
      requireActive(activity);
      const artifact = await requireScheduleArtifact(trx, activity);
      const entries = await listScheduleEntries(trx, activity.id, mode);
      if (entries.length === 0) throw new DomainError("SCHEDULE_EMPTY", "Add at least one entry before releasing.");
      const revision = await staleSafe(() => bumpScheduleState(trx, activity.id, mode, input.expectedRevision));
      const releases = await listScheduleReleases(trx, activity.id, mode);
      const version = (releases[0]?.version ?? 0) + 1;
      const releasedAt = deps.now();
      const release = await insertScheduleRelease(trx, {
        id: idFromCommand("schedule-release", `${activity.id}:${mode}:${version}`),
        activityId: activity.id,
        mode,
        version,
        note: input.note?.slice(0, 500) ?? "",
        releasedAt,
        snapshot: {
          version: 1,
          schemaVersion: 1,
          entries: entries.map((entry, index) => ({
            order: index + 1,
            slotKey: entry.slotKey,
            slotLabel:
              artifact.slots.find((slot) => slot.key === entry.slotKey)?.label ?? entry.slotKey,
            participantId: entry.participantId,
            title: entry.title,
            note: entry.note,
          })),
          releasedAt,
        },
      });
      await appendEngineEvent(trx, deps, {
        type: "ScheduleReleased",
        activityId: activity.id,
        aggregateType: "schedule_release",
        aggregateId: release.id,
        revision,
        mode,
        scope: "schedule",
        capability: "schedule",
        payload: { releaseId: release.id, version, mode },
      });
      return { body: release, status: 201 };
    },
  );
}

export interface RevokeScheduleReleaseInput {
  readonly commandId: string;
  readonly activityId: string;
  readonly releaseId: string;
  readonly note?: string;
}

export async function revokeScheduleReleaseCommand(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: RevokeScheduleReleaseInput,
): Promise<CommandOutcome<StoredScheduleRelease>> {
  const actor = runtimeActor(deps);
  return executeCommand(
    db,
    {
      commandId: input.commandId,
      activityId: input.activityId,
      capability: "schedule",
      commandType: "schedule.release.revoke",
      actor,
      payload: { releaseId: input.releaseId, note: input.note ?? "" },
    },
    async (trx) => {
      requireManager(actor);
      const activity = await getActivityForUpdate(trx, input.activityId);
      if (activity === null) throw new DomainError("NOT_FOUND", "The activity was not found.");
      requireActive(activity);
      const revoked = await revokeScheduleRelease(trx, input.releaseId, input.note?.slice(0, 500) ?? "");
      if (revoked === null) throw new DomainError("NOT_FOUND", "The active schedule release was not found.");
      await appendEngineEvent(trx, deps, {
        type: "ScheduleRevoked",
        activityId: activity.id,
        aggregateType: "schedule_release",
        aggregateId: revoked.id,
        revision: revoked.version,
        mode: revoked.mode,
        scope: "schedule",
        capability: "schedule",
        payload: { releaseId: revoked.id, mode: revoked.mode },
      });
      return { body: revoked };
    },
  );
}

export interface AdvanceScheduleInput {
  readonly commandId: string;
  readonly activityId: string;
}

export async function advanceSchedule(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: AdvanceScheduleInput,
): Promise<CommandOutcome<{ readonly currentEntryId: string; readonly nextEntryId: string | null; readonly mode: ScheduleMode }>> {
  const actor = runtimeActor(deps);
  return executeCommand(
    db,
    {
      commandId: input.commandId,
      activityId: input.activityId,
      capability: "schedule",
      commandType: "schedule.current.advance",
      actor,
      scope: "schedule",
      payload: {},
    },
    async (trx) => {
      const activity = await getActivityForUpdate(trx, input.activityId);
      if (activity === null) throw new DomainError("NOT_FOUND", "The activity was not found.");
      requireActive(activity);
      const running = await requireRunningCommandSession(trx, activity, "schedule.current.advance", "schedule");
      const mode = requireMode(running.session.mode);
      const entries = await listScheduleEntries(trx, activity.id, mode);
      if (entries.length === 0) throw new DomainError("SCHEDULE_EMPTY", "The schedule has no entries.");
      const currentId = await getScheduleCurrent(trx, activity.id, mode);
      const index = entries.findIndex((entry) => entry.id === currentId);
      const next = entries[index + 1] ?? entries[0];
      if (next === undefined) throw new DomainError("SCHEDULE_EMPTY", "The schedule has no entries.");
      await setScheduleCurrent(trx, activity.id, mode, next.id);
      await appendEngineEvent(trx, deps, {
        type: "ScheduleAdvanced",
        activityId: activity.id,
        aggregateType: "schedule",
        aggregateId: `${activity.id}:${mode}`,
        revision: index + 1,
        mode,
        scope: "schedule",
        capability: "schedule",
        payload: { currentEntryId: next.id, mode },
      });
      return {
        body: {
          currentEntryId: next.id,
          nextEntryId: entries[index + 2]?.id ?? null,
          mode,
        },
      };
    },
  );
}
