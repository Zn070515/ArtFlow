import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";

import { fetchOpsActivities, fetchOpsRegistrations, fetchOpsRoster } from "../api/ops.js";
import { RequireSession } from "../auth/RequireSession.js";
import { hasOpsAccess, useSession } from "../auth/SessionProvider.js";
import { GroupingCard } from "../components/ops/GroupingCard.js";
import { RegistrationTable } from "../components/ops/RegistrationTable.js";
import { RosterCard } from "../components/ops/RosterCard.js";
import { VotingCard } from "../components/ops/VotingCard.js";

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

  if (!allowed) {
    return <p className="form-error" role="alert">当前账号不能访问 Ops。</p>;
  }
  const activity = activities.data?.find((item) => item.id === activityId);

  return (
    <section className="ops-page">
      <header className="ops-header">
        <div>
          <Link to="/ops" className="table-link">
            ← 返回活动列表
          </Link>
          <p className="eyebrow">OPS · {activity?.status ?? "ACTIVITY"}</p>
          <h1 className="display results-title">{activity?.title ?? activityId}</h1>
          {activity === undefined ? null : <p className="state-copy">公开码 {activity.publicCode}</p>}
        </div>
      </header>
      <div className="ops-grid">
        <section className="ops-card">
          <p className="eyebrow">REGISTRATIONS · 报名</p>
          <h2>报名</h2>
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
        </section>
        {roster.isPending ? (
          <section className="ops-card">
            <p className="auth-loading">正在加载名单…</p>
          </section>
        ) : roster.error !== null ? (
          <section className="ops-card">
            <p className="form-error" role="alert">名单状态暂时无法加载。</p>
          </section>
        ) : (
          <RosterCard activityId={activityId} roster={roster.data!} />
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
      </div>
    </section>
  );
}
