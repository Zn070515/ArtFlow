import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { useState } from "react";

import { ApiError } from "../api/client.js";
import {
  activateStudioActivity,
  fetchStudioState,
  type StudioState,
} from "../api/studio.js";
import { RequireSession } from "../auth/RequireSession.js";
import { hasStudioAccess, useSession } from "../auth/SessionProvider.js";
import { DefinitionEditor } from "../components/studio/DefinitionEditor.js";
import { ReleasePanel } from "../components/studio/ReleasePanel.js";
import { SessionPanel } from "../components/studio/SessionPanel.js";

export function StudioActivityPage() {
  return (
    <RequireSession>
      <StudioActivityContent />
    </RequireSession>
  );
}

function GuidedSummary({ state }: { readonly state: StudioState }) {
  const manifest = state.draft?.package as
    | { manifest?: { key?: string; title?: string } }
    | undefined;
  return (
    <section className="ops-card">
      <p className="eyebrow">GUIDED · 摘要</p>
      <h2 className="console-card-title">组合</h2>
      <p className="state-copy">
        已启用：{state.activity.enabledCapabilities.join(", ")}
      </p>
      {manifest?.manifest === undefined ? null : (
        <p className="state-copy">
          Manifest：{manifest.manifest.key} · {manifest.manifest.title}
        </p>
      )}
      {state.compiled === null ? null : (
        <p className="state-copy">已编译：{state.compiled.capabilities.join(", ")}</p>
      )}
    </section>
  );
}

function StudioActivityContent() {
  const { activityId } = useParams({ from: "/studio/$activityId" });
  const { session } = useSession();
  const queryClient = useQueryClient();
  const allowed = hasStudioAccess(session);
  const [activating, setActivating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ["studio-state", activityId],
    queryFn: () => fetchStudioState(activityId),
    enabled: allowed,
    retry: false,
  });

  function refresh(): void {
    void queryClient.invalidateQueries({ queryKey: ["studio-state", activityId] });
    void queryClient.invalidateQueries({ queryKey: ["studio-activities"] });
  }

  async function activate(): Promise<void> {
    if (query.data === undefined) return;
    setActivating(true);
    setError(null);
    try {
      await activateStudioActivity(
        activityId,
        crypto.randomUUID(),
        query.data.activity.revision,
      );
      refresh();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "激活失败，请稍后重试。");
    } finally {
      setActivating(false);
    }
  }

  if (!allowed) {
    return (
      <section className="console-state">
        <p className="eyebrow">STUDIO</p>
        <h1 className="console-page-title">没有 Studio 权限</h1>
        <p className="state-copy">当前账号缺少 studio.manage。</p>
      </section>
    );
  }
  if (query.isPending) return <p className="auth-loading">正在加载 Studio 状态…</p>;
  if (query.error !== null) {
    return <p className="form-error" role="alert">Studio 状态暂时无法加载。</p>;
  }

  const state = query.data;
  return (
    <section className="studio-page">
      <header className="studio-header console-page-header">
        <div>
          <Link to="/studio" className="table-link">
            ← 返回活动列表
          </Link>
          <p className="eyebrow">STUDIO · {state.activity.status}</p>
          <h1 className="console-page-title">{state.activity.title}</h1>
          <p className="state-copy">
            公开码 {state.activity.publicCode} · revision {state.activity.revision} · active release v
            {state.activity.activeDefinitionVersion}
          </p>
        </div>
        {state.activity.status === "draft" ? (
          <button
            className="primary-button"
            type="button"
            disabled={activating}
            onClick={() => void activate()}
          >
            {activating ? "正在激活…" : "激活活动"}
          </button>
        ) : null}
      </header>
      {error === null ? null : (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="studio-grid studio-workspace">
        <div className="studio-main-column">
          <DefinitionEditor state={state} onChanged={refresh} />
        </div>
        <aside className="studio-rail" aria-label="Studio 操作栏">
          <ReleasePanel state={state} onChanged={refresh} />
          <SessionPanel state={state} onChanged={refresh} />
          <GuidedSummary state={state} />
        </aside>
      </div>
    </section>
  );
}
