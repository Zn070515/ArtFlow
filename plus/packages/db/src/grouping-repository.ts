import type {
  GroupingMaterialWindow,
  GroupingRosterSource,
  GroupingStageStatus,
} from "@artflow-plus/domain";
import type { Kysely, Selectable } from "kysely";

import type {
  Database,
  GroupingGroupRow,
  GroupingMembershipRow,
  GroupingStageRow,
} from "./types.js";

export interface StoredGroupingStage {
  readonly id: string;
  readonly activityId: string;
  readonly stageKey: string;
  readonly name: string;
  readonly status: GroupingStageStatus;
  readonly rosterSource: GroupingRosterSource;
  readonly sourceRoundId?: string;
  readonly sourceFingerprint: string;
  readonly materialWindow: GroupingMaterialWindow;
  readonly cancelReason: string;
  readonly confirmedAt?: string;
  readonly confirmedBy?: string;
  readonly frozenAt?: string;
  readonly frozenBy?: string;
  readonly cancelledAt?: string;
  readonly cancelledBy?: string;
  readonly revision: number;
}

export interface StoredGroupingGroup {
  readonly id: string;
  readonly stageId: string;
  readonly groupOrder: number;
  readonly name: string;
  readonly isActive: boolean;
}

export interface StoredGroupingMembership {
  readonly id: string;
  readonly stageId: string;
  readonly groupId: string;
  readonly participantId: string;
  readonly isCurrent: boolean;
  readonly joinedAt: string;
  readonly leftAt?: string;
  readonly removedBy?: string;
  readonly reason: string;
}

function iso(value: Date | string | null): string | undefined {
  if (value === null) return undefined;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function stage(row: Selectable<GroupingStageRow>): StoredGroupingStage {
  const confirmedAt = iso(row.confirmed_at);
  const frozenAt = iso(row.frozen_at);
  const cancelledAt = iso(row.cancelled_at);
  return {
    id: row.id,
    activityId: row.activity_id,
    stageKey: row.stage_key,
    name: row.name,
    status: row.status as GroupingStageStatus,
    rosterSource: row.roster_source as GroupingRosterSource,
    ...(row.source_round_id === null ? {} : { sourceRoundId: row.source_round_id }),
    sourceFingerprint: row.source_fingerprint,
    materialWindow: row.material_window as GroupingMaterialWindow,
    cancelReason: row.cancel_reason,
    ...(confirmedAt === undefined ? {} : { confirmedAt }),
    ...(row.confirmed_by === null ? {} : { confirmedBy: row.confirmed_by }),
    ...(frozenAt === undefined ? {} : { frozenAt }),
    ...(row.frozen_by === null ? {} : { frozenBy: row.frozen_by }),
    ...(cancelledAt === undefined ? {} : { cancelledAt }),
    ...(row.cancelled_by === null ? {} : { cancelledBy: row.cancelled_by }),
    revision: row.revision,
  };
}

function group(row: Selectable<GroupingGroupRow>): StoredGroupingGroup {
  return {
    id: row.id,
    stageId: row.stage_id,
    groupOrder: row.group_order,
    name: row.name,
    isActive: row.is_active,
  };
}

function membership(row: Selectable<GroupingMembershipRow>): StoredGroupingMembership {
  const joinedAt = iso(row.joined_at);
  const leftAt = iso(row.left_at);
  return {
    id: row.id,
    stageId: row.stage_id,
    groupId: row.group_id,
    participantId: row.participant_id,
    isCurrent: row.is_current,
    joinedAt: joinedAt ?? new Date().toISOString(),
    ...(leftAt === undefined ? {} : { leftAt }),
    ...(row.removed_by === null ? {} : { removedBy: row.removed_by }),
    reason: row.reason,
  };
}

export async function insertGroupingStage(
  db: Kysely<Database>,
  value: StoredGroupingStage,
  createdAt: string,
): Promise<void> {
  await db.insertInto("grouping_stage").values({
    id: value.id,
    activity_id: value.activityId,
    stage_key: value.stageKey,
    name: value.name,
    status: value.status,
    roster_source: value.rosterSource,
    source_round_id: value.sourceRoundId ?? null,
    source_fingerprint: value.sourceFingerprint,
    material_window: value.materialWindow,
    cancel_reason: value.cancelReason,
    confirmed_at: value.confirmedAt ?? null,
    confirmed_by: value.confirmedBy ?? null,
    frozen_at: value.frozenAt ?? null,
    frozen_by: value.frozenBy ?? null,
    cancelled_at: value.cancelledAt ?? null,
    cancelled_by: value.cancelledBy ?? null,
    revision: value.revision,
    created_at: new Date(createdAt),
    updated_at: createdAt,
  }).execute();
}

export async function getGroupingStageForUpdate(
  db: Kysely<Database>,
  activityId: string,
  stageId: string,
): Promise<StoredGroupingStage | null> {
  const row = await db.selectFrom("grouping_stage").selectAll()
    .where("id", "=", stageId).where("activity_id", "=", activityId)
    .forUpdate().executeTakeFirst();
  return row === undefined ? null : stage(row);
}

export async function getGroupingStageByKey(
  db: Kysely<Database>,
  activityId: string,
  stageKey: string,
): Promise<StoredGroupingStage | null> {
  const row = await db.selectFrom("grouping_stage").selectAll()
    .where("activity_id", "=", activityId).where("stage_key", "=", stageKey)
    .executeTakeFirst();
  return row === undefined ? null : stage(row);
}

export async function listGroupingStages(
  db: Kysely<Database>,
  activityId: string,
): Promise<readonly StoredGroupingStage[]> {
  const rows = await db.selectFrom("grouping_stage").selectAll()
    .where("activity_id", "=", activityId)
    .orderBy("stage_key", "asc").execute();
  return rows.map(stage);
}

export async function updateGroupingStage(
  db: Kysely<Database>,
  value: StoredGroupingStage,
  expectedRevision: number,
): Promise<boolean> {
  const result = await db.updateTable("grouping_stage").set({
    name: value.name,
    status: value.status,
    roster_source: value.rosterSource,
    source_round_id: value.sourceRoundId ?? null,
    source_fingerprint: value.sourceFingerprint,
    material_window: value.materialWindow,
    cancel_reason: value.cancelReason,
    confirmed_at: value.confirmedAt ?? null,
    confirmed_by: value.confirmedBy ?? null,
    frozen_at: value.frozenAt ?? null,
    frozen_by: value.frozenBy ?? null,
    cancelled_at: value.cancelledAt ?? null,
    cancelled_by: value.cancelledBy ?? null,
    revision: value.revision,
    updated_at: new Date().toISOString(),
  })
    .where("id", "=", value.id)
    .where("activity_id", "=", value.activityId)
    .where("revision", "=", expectedRevision)
    .executeTakeFirst();
  return Number(result.numUpdatedRows) === 1;
}

export async function insertGroupingGroup(
  db: Kysely<Database>,
  value: StoredGroupingGroup,
  createdAt: string,
): Promise<void> {
  await db.insertInto("grouping_group").values({
    id: value.id,
    stage_id: value.stageId,
    group_order: value.groupOrder,
    name: value.name,
    is_active: value.isActive,
    created_at: new Date(createdAt),
    updated_at: createdAt,
  }).execute();
}

export async function updateGroupingGroup(
  db: Kysely<Database>,
  value: StoredGroupingGroup,
): Promise<void> {
  await db.updateTable("grouping_group")
    .set({
      group_order: value.groupOrder,
      name: value.name,
      is_active: value.isActive,
      updated_at: new Date().toISOString(),
    })
    .where("id", "=", value.id).execute();
}

export async function deactivateGroupingGroups(
  db: Kysely<Database>,
  stageId: string,
  exceptGroupIds: readonly string[],
): Promise<void> {
  const active = await db.selectFrom("grouping_group").select("id")
    .where("stage_id", "=", stageId).where("is_active", "=", true).execute();
  const keep = new Set(exceptGroupIds);
  const toDeactivate = active.map((row) => row.id).filter((id) => !keep.has(id));
  if (toDeactivate.length === 0) return;
  await db.updateTable("grouping_group")
    .set({ is_active: false, updated_at: new Date().toISOString() })
    .where("id", "in", toDeactivate)
    .execute();
}

export async function deleteGroupingGroups(
  db: Kysely<Database>,
  stageId: string,
): Promise<void> {
  await db.deleteFrom("grouping_group").where("stage_id", "=", stageId).execute();
}

export async function listGroupingGroups(
  db: Kysely<Database>,
  stageIds: readonly string[],
): Promise<readonly StoredGroupingGroup[]> {
  if (stageIds.length === 0) return [];
  const rows = await db.selectFrom("grouping_group").selectAll()
    .where("stage_id", "in", [...stageIds])
    .orderBy("stage_id", "asc").orderBy("group_order", "asc").execute();
  return rows.map(group);
}

export async function insertGroupingMembership(
  db: Kysely<Database>,
  value: StoredGroupingMembership,
): Promise<void> {
  await db.insertInto("grouping_membership").values({
    id: value.id,
    stage_id: value.stageId,
    group_id: value.groupId,
    participant_id: value.participantId,
    is_current: value.isCurrent,
    joined_at: value.joinedAt,
    left_at: value.leftAt ?? null,
    removed_by: value.removedBy ?? null,
    reason: value.reason,
  }).execute();
}

export async function closeCurrentGroupingMemberships(
  db: Kysely<Database>,
  stageId: string,
  leftAt: string,
  removedBy: string,
  reason: string,
): Promise<void> {
  await db.updateTable("grouping_membership")
    .set({ is_current: false, left_at: leftAt, removed_by: removedBy, reason })
    .where("stage_id", "=", stageId)
    .where("is_current", "=", true)
    .execute();
}

export async function listCurrentGroupingMemberships(
  db: Kysely<Database>,
  stageId: string,
): Promise<readonly StoredGroupingMembership[]> {
  const rows = await db.selectFrom("grouping_membership").selectAll()
    .where("stage_id", "=", stageId).where("is_current", "=", true)
    .orderBy("group_id", "asc").orderBy("participant_id", "asc").execute();
  return rows.map(membership);
}

export async function listGroupingMembershipsForStages(
  db: Kysely<Database>,
  stageIds: readonly string[],
): Promise<readonly StoredGroupingMembership[]> {
  if (stageIds.length === 0) return [];
  const rows = await db.selectFrom("grouping_membership").selectAll()
    .where("stage_id", "in", [...stageIds]).where("is_current", "=", true)
    .orderBy("stage_id", "asc").orderBy("group_id", "asc").orderBy("participant_id", "asc").execute();
  return rows.map(membership);
}

export async function listParticipantLabels(
  db: Kysely<Database>,
  activityId: string,
): Promise<ReadonlyMap<string, string>> {
  const registrations = await db.selectFrom("registration")
    .select(["participant_id", "answers"])
    .where("activity_id", "=", activityId).execute();
  const accounts = await db.selectFrom("local_account")
    .select(["actor_id", "username"]).execute();
  const usernames = new Map(accounts.map((row) => [row.actor_id, row.username]));
  const labels = new Map<string, string>();
  for (const row of registrations) {
    let name = "";
    try {
      const answers = typeof row.answers === "string" ? JSON.parse(row.answers) : row.answers;
      if (answers !== null && typeof answers === "object") {
        const value = (answers as Record<string, unknown>).name;
        if (typeof value === "string") name = value.trim();
      }
    } catch {
      name = "";
    }
    labels.set(row.participant_id, name || usernames.get(row.participant_id) || row.participant_id);
  }
  return labels;
}
