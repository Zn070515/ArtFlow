import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";

import { fetchRegistrationDetail, type RegistrationDetail, type RegistrationMaterial } from "../api/registrations.js";
import { RequireSession } from "../auth/RequireSession.js";
import { hasOpsAccess, useSession } from "../auth/SessionProvider.js";
import { ReviewPanel } from "../components/ops/ReviewPanel.js";

function materialContentUrl(activityId: string, materialId: string): string {
  return `/api/activities/${activityId}/materials/${materialId}/content`;
}

function MaterialAnswer({
  activityId,
  material,
  purpose,
}: {
  readonly activityId: string;
  readonly material: RegistrationMaterial | undefined;
  readonly purpose: string | undefined;
}) {
  if (material === undefined) return <span className="answer-value">未登记</span>;
  const stored = material.contentReady !== false;
  const href = materialContentUrl(activityId, material.id);
  const playable = stored && (material.contentType.startsWith("audio/") || purpose === "audio");
  return (
    <div className="answer-value material-answer">
      <span>{material.originalName} · {material.byteLength} B</span>
      {stored ? (
        <span className="material-actions">
          <a className="table-link" href={href} download={material.originalName}>下载</a>
          {playable ? (
            <audio controls preload="none" src={href} aria-label={`试听 ${material.originalName}`} />
          ) : (
            <a className="table-link" href={href} target="_blank" rel="noreferrer">打开</a>
          )}
        </span>
      ) : (
        <span>仅元数据</span>
      )}
    </div>
  );
}

export function OpsRegistrationPage() {
  return (
    <RequireSession>
      <OpsRegistrationContent />
    </RequireSession>
  );
}

function DetailView({
  activityId,
  detail,
}: {
  readonly activityId: string;
  readonly detail: RegistrationDetail;
}) {
  return (
    <section className="ops-card">
      <p className="eyebrow">REGISTRATION · 报名</p>
      <h2 className="console-card-title">报名信息</h2>
      <p className="state-copy">
        参与者 {detail.registration.participantId} · 状态 {detail.registration.status} · 修订{" "}
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
            return (
              <div className="answer-row" key={question.key}>
                <span className="answer-label">{question.label}</span>
                {question.type === "file" ? (
                  <MaterialAnswer
                    activityId={activityId}
                    material={material}
                    purpose={question.file?.purpose}
                  />
                ) : (
                  <span className="answer-value">
                    {typeof raw === "string" && raw.trim() ? raw : "—"}
                  </span>
                )}
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
        <DetailView activityId={activityId} detail={query.data} />
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
