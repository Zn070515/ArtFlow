import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";

import { fetchRegistrationDetail, type RegistrationDetail } from "../api/registrations.js";
import { RequireSession } from "../auth/RequireSession.js";
import { hasOpsAccess, useSession } from "../auth/SessionProvider.js";
import { ReviewPanel } from "../components/ops/ReviewPanel.js";

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
      <h1 className="display results-title">{detail.activity.title}</h1>
      <p className="state-copy">
        参与者 {detail.registration.participantId} · 状态 {detail.registration.status} · 修订{" "}
        {detail.registration.revision}
      </p>
      {detail.registration.reviewNote === undefined ? null : (
        <p className="review-note">审核意见：{detail.registration.reviewNote}</p>
      )}
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
                  : `${material.originalName}（${material.byteLength} B，仅元数据）`
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
      <Link to="/ops/$activityId" params={{ activityId }} className="table-link">
        ← 返回活动
      </Link>
      <div className="ops-grid">
        <DetailView detail={query.data} />
        <ReviewPanel
          detail={query.data}
          onReviewed={() => {
            void queryClient.invalidateQueries({
              queryKey: ["registration-detail", activityId, registrationId],
            });
            void queryClient.invalidateQueries({ queryKey: ["ops-registrations", activityId] });
            void queryClient.invalidateQueries({ queryKey: ["ops-roster", activityId] });
          }}
        />
      </div>
    </section>
  );
}
