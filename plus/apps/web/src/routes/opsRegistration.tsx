import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";

import { fetchRegistrationDetail, type RegistrationDetail } from "../api/registrations.js";
import { RequireSession } from "../auth/RequireSession.js";
import { hasOpsAccess, useSession } from "../auth/SessionProvider.js";
import { MaterialsReviewPanel } from "../components/ops/MaterialsReviewPanel.js";
import { ReviewPanel } from "../components/ops/ReviewPanel.js";
import { SupplementPanel } from "../components/ops/SupplementPanel.js";

export function OpsRegistrationPage() {
  return (
    <RequireSession>
      <OpsRegistrationContent />
    </RequireSession>
  );
}

function DetailView({ detail }: { readonly detail: RegistrationDetail }) {
  return (
    <section className="ops-card">
      <p className="eyebrow">REGISTRATION · 报名</p>
      <h2 className="console-card-title">报名信息</h2>
      <p className="state-copy">
        参与者{" "}
        {typeof detail.registration.answers.name === "string" && detail.registration.answers.name.trim()
          ? detail.registration.answers.name
          : detail.registration.participantId}{" "}
        · {detail.registration.participantId} · 状态 {detail.registration.status} · 修订{" "}
        {detail.registration.revision}
      </p>
      {detail.registration.reviewNote?.trim() ? (
        <p className="review-note">审核意见：{detail.registration.reviewNote}</p>
      ) : null}
      <div className="answer-list">
        {detail.questionnaire.questions
          .filter((question) => question.type !== "notice")
          .map((question) => {
            const raw = detail.registration.answers[question.key];
            const material = detail.materials.find((item) => item.questionKey === question.key);
            const value =
              question.type === "file"
                ? material === undefined
                  ? "未登记"
                  : (
                    <span>
                      {material.originalName}（{material.byteLength} B）
                      {material.contentReady ? (
                        <>
                          {" · "}
                          <a
                            href={`/api/activities/${detail.activity.id}/materials/${material.id}/content`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            播放 / 下载
                          </a>
                        </>
                      ) : (
                        " · 字节未保存"
                      )}
                    </span>
                  )
                : typeof raw === "string" && raw.trim()
                  ? raw
                  : "—";
            return (
              <div className="answer-row" key={question.key}>
                <span className="answer-label">{question.label}</span>
                <span className="answer-value">{value}</span>
              </div>
            );
          })}
      </div>
    </section>
  );
}

function OpsRegistrationContent() {
  const { activityId, registrationId } = useParams({
    from: "/ops/$activityId/registrations/$registrationId",
  });
  const { session } = useSession();
  const queryClient = useQueryClient();
  const allowed = hasOpsAccess(session);
  const permissions = session?.actor.permissions ?? [];
  const can = (permission: string): boolean =>
    permissions.includes("*") || permissions.includes(permission);
  const refresh = (): void => {
    void queryClient.invalidateQueries({
      queryKey: ["registration-detail", activityId, registrationId],
    });
    void queryClient.invalidateQueries({ queryKey: ["ops-registrations", activityId] });
    void queryClient.invalidateQueries({ queryKey: ["ops-roster", activityId] });
  };
  const query = useQuery({
    queryKey: ["registration-detail", activityId, registrationId],
    queryFn: () => fetchRegistrationDetail(activityId, registrationId),
    enabled: allowed,
    retry: false,
  });

  if (!allowed) {
    return <p className="form-error" role="alert">当前账号不能访问 Ops。</p>;
  }
  if (query.isPending) return <p className="auth-loading">正在加载报名详情…</p>;
  if (query.error !== null) {
    return <p className="form-error" role="alert">报名详情暂时无法加载。</p>;
  }

  return (
    <section className="ops-page">
      <header className="console-page-header">
        <div>
          <Link to="/ops/$activityId" params={{ activityId }} className="table-link">
            ← 返回活动
          </Link>
          <p className="eyebrow">OPS · REGISTRATION</p>
          <h1 className="console-page-title">{query.data.activity.title}</h1>
          <p className="state-copy">
            {query.data.registration.participantId} · 状态 {query.data.registration.status}
          </p>
        </div>
      </header>
      <div className="ops-grid">
        <DetailView detail={query.data} />
        <ReviewPanel detail={query.data} onReviewed={refresh} />
        <MaterialsReviewPanel
          detail={query.data}
          canManage={can("materials.review")}
          onReviewed={refresh}
        />
        <SupplementPanel
          detail={query.data}
          canManage={can("registration.review")}
          onIssued={refresh}
        />
      </div>
    </section>
  );
}
