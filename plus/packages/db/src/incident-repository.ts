import type {
  IncidentCategory,
  IncidentSeverity,
  IncidentStatus,
} from "@artflow-plus/domain";
import { sql, type Kysely, type Selectable } from "kysely";

import { StaleRevisionError } from "./activity-repository.js";
import type { Database, IncidentRow } from "./types.js";

export type IncidentMode = "test" | "rehearsal" | "formal";
export type IncidentRelatedType =
  | "schedule_entry"
  | "performance"
  | "round"
  | "registration";

export interface StoredIncident {
  readonly id: string;
  readonly activityId: string;
  readonly mode: IncidentMode;
  readonly severity: IncidentSeverity;
  readonly category: IncidentCategory;
  readonly status: IncidentStatus;
  readonly title: string;
  readonly detail: string;
  readonly location: string;
  readonly relatedType: IncidentRelatedType | null;
  readonly relatedId: string | null;
  readonly assigneeId: string | null;
  readonly resolution: string;
  readonly openedBy: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function incident(row: Selectable<IncidentRow>): StoredIncident {
  return {
    id: row.id,
    activityId: row.activity_id,
    mode: row.mode as IncidentMode,
    severity: row.severity as IncidentSeverity,
    category: row.category as IncidentCategory,
    status: row.status as IncidentStatus,
    title: row.title,
    detail: row.detail,
    location: row.location,
    relatedType: row.related_type as IncidentRelatedType | null,
    relatedId: row.related_id,
    assigneeId: row.assignee_id,
    resolution: row.resolution,
    openedBy: row.opened_by,
    revision: row.revision,
    createdAt: iso(row.created_at) ?? "",
    updatedAt: iso(row.updated_at) ?? "",
  };
}

export async function insertIncident(
  db: Kysely<Database>,
  value: StoredIncident,
): Promise<StoredIncident> {
  const row = await db
    .insertInto("incident")
    .values({
      id: value.id,
      activity_id: value.activityId,
      mode: value.mode,
      severity: value.severity,
      category: value.category,
      status: value.status,
      title: value.title,
      detail: value.detail,
      location: value.location,
      related_type: value.relatedType,
      related_id: value.relatedId,
      assignee_id: value.assigneeId,
      resolution: value.resolution,
      opened_by: value.openedBy,
      revision: value.revision,
      created_at: new Date(),
      updated_at: new Date(),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return incident(row);
}

export async function getIncident(
  db: Kysely<Database>,
  incidentId: string,
): Promise<StoredIncident | null> {
  const row = await db
    .selectFrom("incident")
    .selectAll()
    .where("id", "=", incidentId)
    .executeTakeFirst();
  return row === undefined ? null : incident(row);
}

export async function getIncidentForUpdate(
  db: Kysely<Database>,
  incidentId: string,
): Promise<StoredIncident | null> {
  const row = await db
    .selectFrom("incident")
    .selectAll()
    .where("id", "=", incidentId)
    .forUpdate()
    .executeTakeFirst();
  return row === undefined ? null : incident(row);
}

export async function updateIncident(
  db: Kysely<Database>,
  value: StoredIncident,
  expectedRevision: number,
): Promise<StoredIncident> {
  const row = await db
    .updateTable("incident")
    .set({
      severity: value.severity,
      category: value.category,
      status: value.status,
      title: value.title,
      detail: value.detail,
      location: value.location,
      related_type: value.relatedType,
      related_id: value.relatedId,
      assignee_id: value.assigneeId,
      resolution: value.resolution,
      revision: sql`revision + 1`,
      updated_at: new Date(),
    })
    .where("id", "=", value.id)
    .where("activity_id", "=", value.activityId)
    .where("mode", "=", value.mode)
    .where("revision", "=", expectedRevision)
    .returningAll()
    .executeTakeFirst();
  if (row === undefined) throw new StaleRevisionError(value.id);
  return incident(row);
}

export async function listIncidents(
  db: Kysely<Database>,
  activityId: string,
  mode?: IncidentMode,
): Promise<readonly StoredIncident[]> {
  let query = db
    .selectFrom("incident")
    .selectAll()
    .where("activity_id", "=", activityId);
  if (mode !== undefined) query = query.where("mode", "=", mode);
  const rows = await query.orderBy("created_at", "desc").execute();
  return rows.map(incident);
}
