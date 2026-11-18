import type { Database } from "@artflow-plus/db";
import {
  getActivityByPublicCode,
  getScheduleCurrent,
  listVoteSessionsForActivity,
  selectActiveScheduleRelease,
} from "@artflow-plus/db";
import type { Kysely } from "kysely";

export interface PublicScheduleEntry {
  readonly order: number;
  readonly slotLabel: string;
  readonly title: string;
  readonly note: string;
  readonly startsAt: string | null;
}

export interface PublicCurrentProgram {
  readonly activity: {
    readonly publicCode: string;
    readonly title: string;
    readonly status: "active" | "closed";
  };
  readonly current: PublicScheduleEntry | null;
  readonly next: readonly PublicScheduleEntry[];
}

export type PublicVoteEntry = { readonly sessionId: string; readonly status: "open" } | null;

export async function getPublicCurrentProgram(
  db: Kysely<Database>,
  publicCode: string,
): Promise<PublicCurrentProgram | null> {
  const activity = await getActivityByPublicCode(db, publicCode);
  if (activity === null || (activity.status !== "active" && activity.status !== "closed")) {
    return null;
  }
  const release = await selectActiveScheduleRelease(db, publicCode);
  if (release === null) {
    return {
      activity: { publicCode: activity.publicCode, title: activity.title, status: activity.status },
      current: null,
      next: [],
    };
  }
  const entries = release.release.snapshot.entries;
  const currentId = await getScheduleCurrent(db, activity.id, "formal");
  const current = currentId === null
    ? undefined
    : entries.find((entry) => entry.entryId === currentId);
  const toPublic = (entry: (typeof entries)[number]): PublicScheduleEntry => ({
    order: entry.order,
    slotLabel: entry.slotLabel,
    title: entry.title,
    note: entry.note,
    startsAt: entry.startsAt ?? null,
  });
  const next = current === undefined
    ? entries.slice(0, 5).map(toPublic)
    : entries.filter((entry) => entry.order > current.order).slice(0, 5).map(toPublic);
  return {
    activity: { publicCode: activity.publicCode, title: activity.title, status: activity.status },
    current: current === undefined ? null : toPublic(current),
    next,
  };
}

export async function getPublicVoteEntry(
  db: Kysely<Database>,
  publicCode: string,
): Promise<PublicVoteEntry> {
  const activity = await getActivityByPublicCode(db, publicCode);
  if (activity === null || activity.status !== "active") return null;
  const sessions = await listVoteSessionsForActivity(db, activity.id);
  const open = sessions
    .filter((session) => session.mode === "formal" && session.status === "open")
    .sort((left, right) => (right.openedAt ?? "").localeCompare(left.openedAt ?? ""))[0];
  return open === undefined ? null : { sessionId: open.id, status: "open" };
}
