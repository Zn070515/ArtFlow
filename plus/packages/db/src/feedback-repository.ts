import { sql, type Kysely, type Selectable } from "kysely";

import type { ActivityFeedbackRow, Database } from "./types.js";

export interface StoredActivityFeedback {
  readonly id: string;
  readonly activityId: string;
  readonly rating: number;
  readonly comment: string;
  readonly source: string;
  readonly submittedAt: string;
}

export interface ActivityFeedbackSummary {
  readonly count: number;
  readonly average: number | null;
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function feedback(row: Selectable<ActivityFeedbackRow>): StoredActivityFeedback {
  return {
    id: row.id,
    activityId: row.activity_id,
    rating: row.rating,
    comment: row.comment,
    source: row.source,
    submittedAt: iso(row.submitted_at) ?? "",
  };
}

export async function insertActivityFeedback(
  db: Kysely<Database>,
  value: StoredActivityFeedback,
): Promise<StoredActivityFeedback> {
  const row = await db
    .insertInto("activity_feedback")
    .values({
      id: value.id,
      activity_id: value.activityId,
      rating: value.rating,
      comment: value.comment,
      source: value.source,
      submitted_at: new Date(value.submittedAt),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return feedback(row);
}

export async function listActivityFeedback(
  db: Kysely<Database>,
  activityId: string,
  limit = 200,
): Promise<readonly StoredActivityFeedback[]> {
  const rows = await db
    .selectFrom("activity_feedback")
    .selectAll()
    .where("activity_id", "=", activityId)
    .orderBy("submitted_at", "desc")
    .orderBy("id", "desc")
    .limit(limit)
    .execute();
  return rows.map(feedback);
}

export async function summarizeActivityFeedback(
  db: Kysely<Database>,
  activityId: string,
): Promise<ActivityFeedbackSummary> {
  const row = await db
    .selectFrom("activity_feedback")
    .select([
      sql<number>`count(*)::int`.as("count"),
      sql<number | null>`avg(rating)::float8`.as("average"),
    ])
    .where("activity_id", "=", activityId)
    .executeTakeFirstOrThrow();
  return {
    count: row.count,
    average: row.average === null ? null : Number(row.average),
  };
}
