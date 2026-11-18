import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { fetchStudioState, savePublicProfile } from "../api/studio.js";
import { RequireSession } from "../auth/RequireSession.js";
import { hasStudioAccess, useSession } from "../auth/SessionProvider.js";
import { EventAbout } from "../components/portal/EventAbout.js";
import { EventHero } from "../components/portal/EventHero.js";
import {
  fromLocalInput,
  PublicProfileEditor,
  toDraft,
  type PublicProfileDraft,
} from "../components/studio/PublicProfileEditor.js";
import { Button } from "../components/ui/Button.js";
import { Card } from "../components/ui/Card.js";
import { EmptyState } from "../components/ui/EmptyState.js";
import { ErrorState } from "../components/ui/ErrorState.js";
import { apiErrorText } from "../components/ui/apiError.js";

export function StudioPublicProfilePage() {
  return (
    <RequireSession>
      <StudioPublicProfileContent />
    </RequireSession>
  );
}

function StudioPublicProfileContent() {
  const { activityId } = useParams({ from: "/studio/$activityId/public" });
  const { session } = useSession();
  const allowed = hasStudioAccess(session);
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["studio-state", activityId],
    queryFn: () => fetchStudioState(activityId),
    enabled: allowed,
    retry: false,
  });
  const [draft, setDraft] = useState<PublicProfileDraft | null>(null);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (query.data === undefined) return;
    setDraft(toDraft(query.data.publicProfile));
    setRevision(query.data.publicProfile.revision);
  }, [query.data]);

  async function save(): Promise<void> {
    if (draft === null) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const saved = await savePublicProfile(activityId, {
        expectedRevision: revision,
        tagline: draft.tagline,
        description: draft.description,
        venue: draft.venue,
        startsAt: fromLocalInput(draft.startsAt),
        endsAt: fromLocalInput(draft.endsAt),
        organizer: draft.organizer,
        contact: draft.contact,
        announcement: draft.announcement,
      });
      setRevision(saved.revision);
      setMessage("已保存");
      void queryClient.invalidateQueries({ queryKey: ["studio-state", activityId] });
    } catch (caught) {
      setError(apiErrorText(caught, "保存失败，请稍后重试。", "公开资料已被其他操作更新，请刷新后重试。"));
    } finally {
      setBusy(false);
    }
  }

  if (!allowed) {
    return <EmptyState title="没有 Studio 权限" description="当前账号缺少 studio.manage。" />;
  }
  if (query.isPending) return <p className="auth-loading">正在加载公开资料…</p>;
  if (query.error !== null) {
    return (
      <ErrorState
        description="公开资料暂时无法加载。"
        onRetry={() => { void query.refetch(); }}
      />
    );
  }
  const state = query.data;
  if (state === undefined || draft === null) return null;
  const readOnly = state.activity.status === "archived";
  return (
    <section className="studio-page">
      <header className="studio-header">
        <div>
          <Link to="/studio/$activityId" params={{ activityId }} className="table-link">
            ← 返回 Studio
          </Link>
          <h1 className="ui-page-title">公开主页</h1>
          <p className="ui-page-meta">
            公开码 {state.activity.publicCode} · revision {revision}
          </p>
        </div>
        <div className="task-actions">
          {state.activity.status === "draft" ? (
            <span className="ui-card__description">活动激活后公开页才可见</span>
          ) : null}
          <a
            className="ui-button ui-button--secondary ui-button--md"
            href={`/e/${state.activity.publicCode}`}
            target="_blank"
            rel="noreferrer"
          >
            查看公开页
          </a>
          <Button variant="primary" disabled={busy || readOnly} onClick={() => void save()}>
            {busy ? "正在保存…" : "保存"}
          </Button>
        </div>
      </header>
      {message === null ? null : <p className="ui-field__hint" role="status">{message}</p>}
      {error === null ? null : <p className="ui-field__error" role="alert">{error}</p>}
      <div className="studio-grid studio-workspace">
        <Card className="studio-main-column">
          <PublicProfileEditor draft={draft} onChange={setDraft} disabled={readOnly} />
        </Card>
        <aside className="studio-rail" aria-label="公开页预览">
          <Card>
            <h2 className="ui-card__title">预览</h2>
            <EventHero
              preview
              publicCode={state.activity.publicCode}
              title={state.activity.title}
              status={state.activity.status === "closed" ? "closed" : "active"}
              tagline={draft.tagline}
              startsAt={fromLocalInput(draft.startsAt)}
              endsAt={fromLocalInput(draft.endsAt)}
              venue={draft.venue}
              organizer={draft.organizer}
              registrationEnabled={false}
              registrationOpen={false}
              resultsAvailable={false}
            />
            <EventAbout description={draft.description} />
          </Card>
        </aside>
      </div>
    </section>
  );
}
