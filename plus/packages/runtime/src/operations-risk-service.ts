import { listActivities, readActivityAnalytics } from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import { DomainError, hasPermission } from "@artflow-plus/domain";
import type { Kysely } from "kysely";

import { ACTIVITY_ANALYTICS_READ_PERMISSIONS, buildActivityAnalyticsView } from "./analytics-service.js";
import { runtimeActor, type RuntimeDeps } from "./deps.js";

export interface OperationsRiskAttention {
  readonly code: string;
  readonly count?: number;
}

export interface OperationsRiskActivity {
  readonly id: string;
  readonly title: string;
  readonly publicCode: string;
  readonly status: string;
  readonly enabledCapabilities: readonly string[];
}

export interface OperationsRiskRow {
  readonly activity: OperationsRiskActivity;
  readonly attention: readonly OperationsRiskAttention[];
}

export interface OperationsRiskView {
  readonly activities: readonly OperationsRiskRow[];
}

/**
 * Cross-activity attention board. Archived activities are terminal and stay
 * out of the risk data; the /ops list still shows them from its own read.
 *
 * Each activity is read independently, so this is a near-real-time snapshot,
 * not a transactionally consistent view across activities.
 */
export async function getOperationsRiskBoard(
  db: Kysely<Database>,
  deps: RuntimeDeps,
): Promise<OperationsRiskView> {
  const actor = runtimeActor(deps);
  if (!ACTIVITY_ANALYTICS_READ_PERMISSIONS.some((permission) => hasPermission(actor, permission))) {
    throw new DomainError("FORBIDDEN", "An analytics permission is required.");
  }
  const activities = (await listActivities(db)).filter((activity) => activity.status !== "archived");
  const rows = await Promise.all(
    activities.map(async (activity) => {
      const view = buildActivityAnalyticsView(activity, await readActivityAnalytics(db, activity.id));
      return {
        activity: {
          id: activity.id,
          title: activity.title,
          publicCode: activity.publicCode,
          status: activity.status,
          enabledCapabilities: activity.enabledCapabilities,
        },
        attention: view.attention.map((item) =>
          item.count === undefined ? { code: item.code } : { code: item.code, count: item.count },
        ),
      };
    }),
  );
  return { activities: rows };
}
