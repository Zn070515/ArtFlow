import {
  getActivity as readActivity,
  readActivityAnalytics,
  type ActivityAnalyticsFacts,
  type Database,
} from "@artflow-plus/db";
import { DomainError, hasPermission } from "@artflow-plus/domain";
import type { Activity, ActorContext } from "@artflow-plus/domain";
import type { Kysely } from "kysely";

import { runtimeActor, type RuntimeDeps } from "./deps.js";

export const ACTIVITY_ANALYTICS_READ_PERMISSIONS = [
  "studio.manage",
  "competition.manage",
  "judge.manage",
  "registration.manage",
  "registration.review",
  "registration.roster.finalize",
  "materials.manage",
  "materials.review",
  "grouping.manage",
  "voting.manage",
  "result.manage",
  "archive.manage",
  "ticket.manage",
] as const;

export interface AnalyticsAttention {
  readonly code: string;
  readonly severity: "warning";
  readonly count?: number;
}

export interface ActivityAnalyticsView extends ActivityAnalyticsFacts {
  readonly activity: {
    readonly id: string;
    readonly title: string;
    readonly status: Activity["status"];
    readonly enabledCapabilities: readonly string[];
  };
  readonly attention: readonly AnalyticsAttention[];
}

function canReadAnalytics(actor: ActorContext): boolean {
  return ACTIVITY_ANALYTICS_READ_PERMISSIONS.some((permission) => hasPermission(actor, permission));
}

function hasCapability(activity: Activity, capability: string): boolean {
  return activity.enabledCapabilities.includes(capability);
}

function attention(code: string, count?: number): AnalyticsAttention {
  return count === undefined ? { code, severity: "warning" } : { code, severity: "warning", count };
}

export function buildActivityAnalyticsView(
  activity: Activity,
  facts: ActivityAnalyticsFacts,
): ActivityAnalyticsView {
  const items: AnalyticsAttention[] = [];
  if (hasCapability(activity, "registration")) {
    const pendingReview = (facts.registration.byStatus.submitted ?? 0) +
      (facts.registration.byStatus.need_supplement ?? 0);
    if (pendingReview > 0) items.push(attention("REGISTRATION_REVIEW_PENDING", pendingReview));
  }
  if (hasCapability(activity, "materials") && facts.materialChecks.requiredNotApproved > 0) {
    items.push(attention("REQUIRED_MATERIALS_PENDING", facts.materialChecks.requiredNotApproved));
  }
  if (hasCapability(activity, "registration") && facts.roster.status === "unknown") {
    items.push(attention("ROSTER_NOT_FINAL"));
  }
  if (hasCapability(activity, "voting")) {
    const openVotes = facts.voting.sessions.byStatus.open ?? 0;
    if (openVotes > 0) items.push(attention("FORMAL_VOTE_OPEN", openVotes));
  }
  if (hasCapability(activity, "competition")) {
    const unlockedRounds = facts.competition.rounds.total - facts.competition.rounds.locked;
    if (unlockedRounds > 0) items.push(attention("COMPETITION_ROUND_NOT_LOCKED", unlockedRounds));
  }
  if (hasCapability(activity, "publishing")) {
    if (facts.publishing.stageResults.stale > 0) {
      items.push(attention("RESULT_STALE", facts.publishing.stageResults.stale));
    }
    const unconfirmed = facts.publishing.stageResults.total -
      (facts.publishing.stageResults.byStatus.confirmed ?? 0);
    if (unconfirmed > 0 || facts.publishing.stageResults.confirmedWithoutActiveRelease > 0) {
      const count = unconfirmed + facts.publishing.stageResults.confirmedWithoutActiveRelease;
      items.push(attention("RESULT_RELEASE_PENDING", count));
    }
  }
  if (hasCapability(activity, "archive") && activity.status === "closed" && facts.archive.currentPackages === 0) {
    items.push(attention("ARCHIVE_MISSING"));
  }
  return {
    activity: {
      id: activity.id,
      title: activity.title,
      status: activity.status,
      enabledCapabilities: activity.enabledCapabilities,
    },
    ...facts,
    attention: items,
  };
}

export async function getActivityAnalytics(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  activityId: string,
): Promise<ActivityAnalyticsView> {
  const actor = runtimeActor(deps);
  if (!canReadAnalytics(actor)) {
    throw new DomainError("FORBIDDEN", "An analytics permission is required.");
  }
  const activity = await readActivity(db, activityId);
  if (activity === null) throw new DomainError("NOT_FOUND", `Activity ${activityId} was not found.`);
  return buildActivityAnalyticsView(activity, await readActivityAnalytics(db, activityId));
}
