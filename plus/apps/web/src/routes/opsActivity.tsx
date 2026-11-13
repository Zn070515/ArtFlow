import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";

import { fetchActivityAnalytics } from "../api/analytics.js";
import { fetchExportFormats } from "../api/exports.js";
import { fetchOpsActivities, fetchOpsRegistrations, fetchOpsRoster } from "../api/ops.js";
import { RequireSession } from "../auth/RequireSession.js";
import { hasOpsAccess, useSession } from "../auth/SessionProvider.js";
import { GroupingCard } from "../components/ops/GroupingCard.js";
import { ActivityAnalyticsCard } from "../components/ops/ActivityAnalyticsCard.js";
import { RegistrationTable } from "../components/ops/RegistrationTable.js";
import { RosterCard } from "../components/ops/RosterCard.js";
import { VotingCard } from "../components/ops/VotingCard.js";
import { TasksCard } from "../components/ops/TasksCard.js";
import { AttendanceCard } from "../components/ops/AttendanceCard.js";
import { ExportCard } from "../components/ops/ExportCard.js";
import { TicketsCard } from "../components/ops/TicketsCard.js";
import { Card } from "../components/ui/Card.js";

function can(permissions: readonly string[] | undefined, permission: string): boolean {
  if (permissions === undefined) return false;
  return permissions.includes("*") || permissions.includes(permission);
}

export function OpsActivityPage() {
  return (
    <RequireSession>
      <OpsActivityContent />
    </RequireSession>
  );
}

function OpsActivityContent() {
  const { activityId } = useParams({ from: "/ops/$activityId" });
  const { session } = useSession();
  const allowed = hasOpsAccess(session);
  const activities = useQuery({
    queryKey: ["ops-activities"],
    queryFn: fetchOpsActivities,
    enabled: allowed,
    retry: false,
  });
  const registrations = useQuery({
    queryKey: ["ops-registrations", activityId],
    queryFn: () => fetchOpsRegistrations(activityId),
    enabled: allowed,
    retry: false,
  });
  const roster = useQuery({
    queryKey: ["ops-roster", activityId],
    queryFn: () => fetchOpsRoster(activityId),
    enabled: allowed,
    retry: false,
  });
  const analytics = useQuery({
    queryKey: ["ops-analytics", activityId],
    queryFn: () => fetchActivityAnalytics(activityId),
    enabled: allowed,
    retry: false,
  });
  const exportFormats = useQuery({
    queryKey: ["export-formats"],
    queryFn: fetchExportFormats,
    enabled: allowed,
    retry: false,
  });

  if (!allowed) {
    return <p className="form-error" role="alert">当前账号不能访问 Ops。</p>;
  }
  const activity = activities.data?.find((item) => item.id === activityId);
  // The roster and registration list load independently. Finalization must not
  // be offered against a projection that has not arrived yet, so the summary
  // stays `null` (and the control stays blocked) until registrations resolve.
  const rosterSummary =
    registrations.data === undefined
      ? null
      : {
          approved: registrations.data.filter((registration) => registration.status === "approved").length,
          pending: registrations.data.filter(
            (registration) =>
              registration.status === "submitted" || registration.status === "need_supplement",
          ).length,
        };

  return (
    <section className="ops-page">
      <header className="ops-header">
        <div>
          <Link to="/ops" className="table-link">
            ← 返回活动列表
          </Link>
          <h1 className="ui-page-title">{activity?.title ?? activityId}</h1>
          {activity === undefined ? null : <p className="ui-page-meta">公开码 {activity.publicCode}</p>}
        </div>
      </header>
      <div className="ops-grid">
        {analytics.isPending ? (
          <Card><p className="auth-loading">正在加载运营分析…</p></Card>
        ) : analytics.error !== null ? (
          <Card><p className="form-error" role="alert">运营分析暂时无法加载。</p></Card>
        ) : analytics.data === undefined ? null : (
          <ActivityAnalyticsCard analytics={analytics.data} />
        )}
        <Card>
          <h2 className="ui-card__title">报名</h2>
          {registrations.isPending ? (
            <p className="auth-loading">正在加载报名…</p>
          ) : registrations.error !== null ? (
            <p className="form-error" role="alert">报名列表暂时无法加载。</p>
          ) : (
            <RegistrationTable
              activityId={activityId}
              registrations={registrations.data ?? []}
            />
          )}
        </Card>
        {roster.isPending ? (
          <Card>
            <p className="auth-loading">正在加载名单…</p>
          </Card>
        ) : roster.error !== null ? (
          <Card>
            <p className="form-error" role="alert">名单状态暂时无法加载。</p>
          </Card>
        ) : (
          <RosterCard activityId={activityId} roster={roster.data!} summary={rosterSummary} />
        )}
        {activity?.enabledCapabilities.includes("grouping") &&
        (session?.actor.permissions.includes("grouping.manage") ?? false) ? (
          <GroupingCard key={activityId} activityId={activityId} />
        ) : null}
        {activity?.enabledCapabilities.includes("voting") ? (
          <VotingCard
            key={activityId}
            activityId={activityId}
            canManageVotes={can(session?.actor.permissions, "voting.manage")}
            canManageResults={can(session?.actor.permissions, "result.manage")}
            canManageSessions={
              can(session?.actor.permissions, "studio.manage") ||
              can(session?.actor.permissions, "competition.manage")
            }
          />
        ) : null}
        {activity?.enabledCapabilities.includes("tasks") ? (
          <TasksCard
            key={activityId}
            activityId={activityId}
            canManage={can(session?.actor.permissions, "tasks.manage")}
          />
        ) : null}
        <ExportCard
          activityId={activityId}
          permissions={session?.actor.permissions ?? []}
          documentFormats={exportFormats.data ?? ["csv"]}
        />
        {activity?.enabledCapabilities.includes("ticketing") ? (
          <TicketsCard
            key={activityId}
            activityId={activityId}
            canManage={can(session?.actor.permissions, "ticket.manage")}
          />
        ) : null}
        {activity?.enabledCapabilities.includes("attendance") ? (
          <AttendanceCard
            key={activityId}
            activityId={activityId}
            canManage={can(session?.actor.permissions, "attendance.manage")}
            canManageSession={
              can(session?.actor.permissions, "studio.manage") ||
              can(session?.actor.permissions, "competition.manage")
            }
          />
        ) : null}
      </div>
    </section>
  );
}
