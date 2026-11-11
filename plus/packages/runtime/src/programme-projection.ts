import type { Database, StoredActivitySummary, StoredRegistration } from "@artflow-plus/db";
import { getActivityByPublicCode, getActivitySummary, getRoster, listRegistrations } from "@artflow-plus/db";
import type { ActivityStatus } from "@artflow-plus/domain";
import { DomainError, hasPermission } from "@artflow-plus/domain";
import type { Kysely } from "kysely";

import { runtimeActor, type RuntimeDeps } from "./deps.js";

const HOST_PERMISSIONS = [
  "registration.review",
  "registration.manage",
  "registration.roster.finalize",
  "studio.manage",
  "competition.manage",
  "judge.manage",
] as const;

const TITLE_KEYS = ["program", "song", "title"] as const;
const PERFORMER_KEYS = ["name", "performer"] as const;
const NOTE_KEYS = ["description", "intro", "notes"] as const;

export type ProgrammeEmptyReason =
  | "activity_not_active"
  | "roster_not_final"
  | "no_approved_programmes";

export interface ProgrammeItem {
  readonly order: number;
  readonly title: string;
  readonly performers: string;
  readonly notes: string;
}

export interface ProgrammeProjection {
  readonly activityTitle: string;
  readonly publicCode: string;
  readonly published: boolean;
  readonly emptyReason: ProgrammeEmptyReason | null;
  readonly items: readonly ProgrammeItem[];
}

export interface ProgrammeSourceRegistration {
  readonly id: string;
  readonly status: string;
  readonly answers: Readonly<Record<string, unknown>>;
}

function textAnswer(
  answers: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): string {
  for (const key of keys) {
    const value = answers[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return "";
}

/**
 * The programme is the finalized roster in registration-id order. It is not a
 * result snapshot and cannot change ranks.
 */
export function projectProgramme(input: {
  readonly activityTitle: string;
  readonly publicCode: string;
  readonly activityStatus: ActivityStatus;
  readonly rosterStatus: "unknown" | "final";
  readonly registrations: readonly ProgrammeSourceRegistration[];
}): ProgrammeProjection {
  const base = {
    activityTitle: input.activityTitle,
    publicCode: input.publicCode,
  };
  if (input.activityStatus === "draft") {
    return { ...base, published: false, emptyReason: "activity_not_active", items: [] };
  }
  if (input.rosterStatus !== "final") {
    return { ...base, published: false, emptyReason: "roster_not_final", items: [] };
  }
  const approved = input.registrations
    .filter((registration) => registration.status === "approved")
    .sort((left, right) => left.id.localeCompare(right.id));
  if (approved.length === 0) {
    return { ...base, published: true, emptyReason: "no_approved_programmes", items: [] };
  }
  return {
    ...base,
    published: true,
    emptyReason: null,
    items: approved.map((registration, index) => ({
      order: index + 1,
      title: textAnswer(registration.answers, TITLE_KEYS) || "未命名节目",
      performers: textAnswer(registration.answers, PERFORMER_KEYS) || "未署名",
      notes: textAnswer(registration.answers, NOTE_KEYS),
    })),
  };
}

async function projectActivity(
  db: Kysely<Database>,
  activity: StoredActivitySummary,
): Promise<ProgrammeProjection> {
  const roster = await getRoster(db, activity.id);
  const registrations: readonly StoredRegistration[] = activity.enabledCapabilities.includes("registration")
    ? await listRegistrations(db, activity.id)
    : [];
  return projectProgramme({
    activityTitle: activity.title,
    publicCode: activity.publicCode,
    activityStatus: activity.status,
    rosterStatus: roster.status,
    registrations,
  });
}

export async function readPublicProgramme(
  db: Kysely<Database>,
  publicCode: string,
): Promise<ProgrammeProjection> {
  const activity = await getActivityByPublicCode(db, publicCode);
  if (activity === null) throw new DomainError("NOT_FOUND", "The activity was not found.");
  return projectActivity(db, activity);
}

export async function readHostProgramme(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  activityId: string,
): Promise<ProgrammeProjection> {
  const actor = runtimeActor(deps);
  if (!HOST_PERMISSIONS.some((permission) => hasPermission(actor, permission))) {
    throw new DomainError("FORBIDDEN", `One of ${HOST_PERMISSIONS.join(", ")} is required.`);
  }
  const activity = await getActivitySummary(db, activityId);
  if (activity === null) throw new DomainError("NOT_FOUND", "The activity was not found.");
  return projectActivity(db, activity);
}
