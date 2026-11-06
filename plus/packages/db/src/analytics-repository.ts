import { sql, type Kysely } from "kysely";

import { validBallotPredicate } from "./voting-ticket-repository.js";
import type { Database } from "./types.js";

interface StatusCountRow {
  readonly status: string;
  readonly count: number | string;
}

interface CountRow {
  readonly count: number | string;
}

export interface ActivityAnalyticsFacts {
  readonly registration: {
    readonly total: number;
    readonly byStatus: Readonly<Record<string, number>>;
  };
  readonly materialChecks: {
    readonly total: number;
    readonly byStatus: Readonly<Record<string, number>>;
    readonly requiredNotApproved: number;
  };
  readonly roster: {
    readonly status: "unknown" | "final";
    readonly approvedCount: number | null;
    readonly revision: number;
  };
  readonly competition: {
    readonly rounds: {
      readonly total: number;
      readonly byState: Readonly<Record<string, number>>;
      readonly locked: number;
    };
    readonly performances: {
      readonly total: number;
      readonly byState: Readonly<Record<string, number>>;
      readonly locked: number;
    };
    readonly scoreFacts: {
      readonly total: number;
      readonly current: number;
    };
  };
  readonly voting: {
    readonly sessions: {
      readonly total: number;
      readonly byStatus: Readonly<Record<string, number>>;
    };
    readonly validBallots: number;
  };
  readonly publishing: {
    readonly stageResults: {
      readonly total: number;
      readonly byStatus: Readonly<Record<string, number>>;
      readonly stale: number;
      readonly confirmedWithoutActiveRelease: number;
    };
    readonly resultReleases: {
      readonly total: number;
      readonly byStatus: Readonly<Record<string, number>>;
    };
  };
  readonly archive: {
    readonly totalPackages: number;
    readonly currentPackages: number;
  };
}

function numberValue(value: number | string | null | undefined): number {
  return Number(value ?? 0);
}

function statusMap(rows: readonly StatusCountRow[]): Readonly<Record<string, number>> {
  return Object.fromEntries(
    [...rows]
      .sort((left, right) => left.status.localeCompare(right.status))
      .map((row) => [row.status, numberValue(row.count)]),
  );
}

function total(statuses: Readonly<Record<string, number>>): number {
  return Object.values(statuses).reduce((sum, count) => sum + count, 0);
}

export async function readActivityAnalytics(
  db: Kysely<Database>,
  activityId: string,
): Promise<ActivityAnalyticsFacts> {
  const [
    registrations,
    materialChecks,
    requiredNotApproved,
    rosterRow,
    rounds,
    performances,
    scoreFacts,
    voteSessions,
    validBallots,
    stageResults,
    staleStageResults,
    confirmedWithoutActiveRelease,
    resultReleases,
    archivePackages,
    currentArchives,
  ] = await Promise.all([
    sql<StatusCountRow>`
      select status, count(*)::int as count
        from registration
       where activity_id = ${activityId}
       group by status
    `.execute(db),
    sql<StatusCountRow>`
      select status, count(*)::int as count
        from material_check
       where activity_id = ${activityId}
       group by status
    `.execute(db),
    sql<CountRow>`
      select count(*)::int as count
        from material_check
       where activity_id = ${activityId}
         and required = true
         and status <> 'approved'
    `.execute(db),
    db.selectFrom("roster")
      .select(["status", "approved_count", "revision"])
      .where("activity_id", "=", activityId)
      .executeTakeFirst(),
    sql<StatusCountRow>`
      select state as status, count(*)::int as count
        from competition_round
       where activity_id = ${activityId}
       group by state
    `.execute(db),
    sql<StatusCountRow>`
      select state as status, count(*)::int as count
        from performance
       where activity_id = ${activityId}
       group by state
    `.execute(db),
    sql<{ readonly total: number | string; readonly current: number | string }>`
      select count(*)::int as total,
             count(*) filter (where current = true)::int as current
        from score_fact
       where activity_id = ${activityId}
    `.execute(db),
    sql<StatusCountRow>`
      select status, count(*)::int as count
        from vote_session
       where activity_id = ${activityId}
       group by status
    `.execute(db),
    sql<CountRow>`
      select count(*)::int as count
        from ballot
        left join ticket on ticket.id = ballot.ticket_id
       where ballot.activity_id = ${activityId}
         and ${validBallotPredicate}
    `.execute(db),
    sql<StatusCountRow>`
      select status, count(*)::int as count
        from stage_result
       where activity_id = ${activityId}
       group by status
    `.execute(db),
    sql<CountRow>`
      select count(*)::int as count
        from stage_result
       where activity_id = ${activityId}
         and stale_at is not null
    `.execute(db),
    sql<CountRow>`
      select count(*)::int as count
        from stage_result
        left join result_release
          on result_release.activity_id = stage_result.activity_id
         and result_release.stage_result_id = stage_result.id
         and result_release.status = 'active'
       where stage_result.activity_id = ${activityId}
         and stage_result.status = 'confirmed'
         and stage_result.stale_at is null
         and result_release.id is null
    `.execute(db),
    sql<StatusCountRow>`
      select status, count(*)::int as count
        from result_release
       where activity_id = ${activityId}
       group by status
    `.execute(db),
    sql<CountRow>`
      select count(*)::int as count
        from archive_package
       where activity_id = ${activityId}
    `.execute(db),
    sql<CountRow>`
      select count(*)::int as count
        from archive_package
       where activity_id = ${activityId}
         and is_current = true
    `.execute(db),
  ]);

  const registrationStatus = statusMap(registrations.rows);
  const materialStatus = statusMap(materialChecks.rows);
  const roundStatus = statusMap(rounds.rows);
  const performanceStatus = statusMap(performances.rows);
  const voteStatus = statusMap(voteSessions.rows);
  const stageStatus = statusMap(stageResults.rows);
  const releaseStatus = statusMap(resultReleases.rows);
  const rosterStatus = rosterRow?.status === "final" ? "final" : "unknown";

  return {
    registration: { total: total(registrationStatus), byStatus: registrationStatus },
    materialChecks: {
      total: total(materialStatus),
      byStatus: materialStatus,
      requiredNotApproved: numberValue(requiredNotApproved.rows[0]?.count),
    },
    roster: {
      status: rosterStatus,
      approvedCount: rosterRow?.approved_count ?? null,
      revision: rosterRow?.revision ?? 0,
    },
    competition: {
      rounds: { total: total(roundStatus), byState: roundStatus, locked: roundStatus.locked ?? 0 },
      performances: { total: total(performanceStatus), byState: performanceStatus, locked: performanceStatus.locked ?? 0 },
      scoreFacts: {
        total: numberValue(scoreFacts.rows[0]?.total),
        current: numberValue(scoreFacts.rows[0]?.current),
      },
    },
    voting: {
      sessions: { total: total(voteStatus), byStatus: voteStatus },
      validBallots: numberValue(validBallots.rows[0]?.count),
    },
    publishing: {
      stageResults: {
        total: total(stageStatus),
        byStatus: stageStatus,
        stale: numberValue(staleStageResults.rows[0]?.count),
        confirmedWithoutActiveRelease: numberValue(confirmedWithoutActiveRelease.rows[0]?.count),
      },
      resultReleases: { total: total(releaseStatus), byStatus: releaseStatus },
    },
    archive: {
      totalPackages: numberValue(archivePackages.rows[0]?.count),
      currentPackages: numberValue(currentArchives.rows[0]?.count),
    },
  };
}
