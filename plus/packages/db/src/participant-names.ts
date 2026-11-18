import type { Kysely } from "kysely";

import type { Database } from "./types.js";

function json(value: unknown): unknown {
  return typeof value === "string" ? (JSON.parse(value) as unknown) : value;
}

/** Names are presentation data; the id is always a safe fallback. */
export function participantName(answers: unknown, fallback: string): string {
  const parsed = json(answers);
  if (parsed === null || typeof parsed !== "object") return fallback;
  for (const key of ["name", "displayName", "title", "program"]) {
    const value = (parsed as Record<string, unknown>)[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return fallback;
}

export async function selectParticipantNames(
  db: Kysely<Database>,
  activityId: string,
  participantIds: readonly string[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (participantIds.length === 0) return names;
  const rows = await db
    .selectFrom("registration")
    .select(["participant_id", "answers"])
    .where("activity_id", "=", activityId)
    .where("participant_id", "in", [...participantIds])
    .execute();
  for (const row of rows) {
    names.set(row.participant_id, participantName(row.answers, row.participant_id));
  }
  return names;
}
