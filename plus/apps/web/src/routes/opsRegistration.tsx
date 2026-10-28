import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { useState } from "react";

import { ApiError } from "../api/client.js";
import { issueParticipantClaim, type ParticipantClaimIssue } from "../api/ops.js";
import { fetchRegistrationDetail, type RegistrationDetail } from "../api/registrations.js";
import { RequireSession } from "../auth/RequireSession.js";
import { hasOpsAccess, useSession } from "../auth/SessionProvider.js";
import { ReviewPanel } from "../components/ops/ReviewPanel.js";
import { copyClaimLink } from "./claim.js";

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

function ParticipantClaimPanel({ detail }: { readonly detail: RegistrationDetail }) {
  const [claim, setClaim] = useState<ParticipantClaimIssue | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const eligible = detail.registration.participantId.startsWith("legacy-user:");

  if (!eligible) return null;

  async function issue(): Promise<void> {
    setBusy(true);
    setCopied(false);
    setError(null);
    try {
      const result = await issueParticipantClaim(
        detail.activity.id,
        detail.registration.id,
        crypto.randomUUID(),
      );
      if (result.token === null) {
        setClaim(null);
        setError("这次请求是一次性响应的重放，未返回新链接；请使用新的操作请求重新生成。");
      } else {
        setClaim(result);
      }
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "认领链接生成失败，请稍后重试。");
    } finally {
      setBusy(false);
    }
  }

  async function copyLink(): Promise<void> {
    if (claim?.token === null || claim?.token === undefined) return;
    const link = `${window.location.origin}/claim#${encodeURIComponent(claim.token)}`;
    setError(null);
    try {
      await copyClaimLink(link);
      setCopied(true);
    } catch (caught) {
      setCopied(false);
      setError(caught instanceof Error ? caught.message : "复制失败，请手动复制链接。");
    }
  }

  return (
    <section className="ops-card claim-panel">
      <p className="eyebrow">ACCOUNT CLAIM · 账号认领</p>
      <h2>生成参与者认领链接</h2>
      <p className="state-copy">导入身份 {detail.registration.participantId} 可绑定到一个新的参与者账号。</p>
      <button className="primary-button" type="button" disabled={busy} onClick={() => void issue()}>
        {busy ? "正在生成…" : "生成参与者认领链接"}
      </button>
      {claim?.token === null || claim?.token === undefined ? null : (
        <div className="claim-result">
          <label className="field">
            <span>一次性链接</span>
            <input
              readOnly
              value={`${window.location.origin}/claim#${encodeURIComponent(claim.token)}`}
              aria-label="一次性认领链接"
            />
          </label>
          <button className="secondary-button" type="button" onClick={() => void copyLink()}>
            {copied ? "已复制" : "复制链接"}
          </button>
          <p className="state-copy">有效期至 {new Date(claim.expiresAt).toLocaleString()}</p>
        </div>
      )}
      {error === null ? null : <p className="form-error" role="alert">{error}</p>}
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
        <ParticipantClaimPanel detail={query.data} />
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
