import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { useState } from "react";

import { ApiError } from "../api/client.js";
import {
  activateStudioActivity,
  fetchStudioState,
  renameStudioActivity,
  type StudioState,
} from "../api/studio.js";
import { RequireSession } from "../auth/RequireSession.js";
import { hasStudioAccess, useSession } from "../auth/SessionProvider.js";
import { DefinitionEditor } from "../components/studio/DefinitionEditor.js";
import { ReleasePanel } from "../components/studio/ReleasePanel.js";
import { SessionPanel } from "../components/studio/SessionPanel.js";
import { Button } from "../components/ui/Button.js";
import { Card } from "../components/ui/Card.js";
import { EmptyState } from "../components/ui/EmptyState.js";
import { ErrorState } from "../components/ui/ErrorState.js";
import { Input } from "../components/ui/Input.js";

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
    <Card>
      <h2 className="ui-card__title">组合</h2>
      <p className="ui-card__description">
        已启用：{state.activity.enabledCapabilities.join(", ")}
      </p>
      {manifest?.manifest === undefined ? null : (
        <p className="ui-card__description">
          Manifest：{manifest.manifest.key} · {manifest.manifest.title}
        </p>
      )}
      {state.compiled === null ? null : (
        <p className="ui-card__description">已编译：{state.compiled.capabilities.join(", ")}</p>
      )}
    </Card>
  );
}

function StudioActivityContent() {
  const { activityId } = useParams({ from: "/studio/$activityId" });
  const { session } = useSession();
  const queryClient = useQueryClient();
  const allowed = hasStudioAccess(session);
  const [activating, setActivating] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState("");
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

  async function rename(): Promise<void> {
    if (query.data === undefined || title.trim() === "") return;
    setRenaming(true);
    setError(null);
    try {
      await renameStudioActivity(
        activityId,
        crypto.randomUUID(),
        title.trim(),
        query.data.activity.revision,
      );
      setRenameOpen(false);
      refresh();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "重命名失败，请稍后重试。");
    } finally {
      setRenaming(false);
    }
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
      <EmptyState
        title="没有 Studio 权限"
        description="当前账号缺少 studio.manage。"
      />
    );
  }
  if (query.isPending) return <p className="auth-loading">正在加载 Studio 状态…</p>;
  if (query.error !== null) {
    return (
      <ErrorState
        description="Studio 状态暂时无法加载。"
        onRetry={() => { void query.refetch(); }}
      />
    );
  }

  const state = query.data;
  return (
    <section className="studio-page">
      <header className="studio-header">
        <div>
          <Link to="/studio" className="table-link">
            ← 返回活动列表
          </Link>
          <h1 className="ui-page-title">{state.activity.title}</h1>
          <p className="ui-page-meta">
            公开码 {state.activity.publicCode} · revision {state.activity.revision} · active release v
            {state.activity.activeDefinitionVersion}
          </p>
        </div>
        <div className="task-actions">
          <Button
            variant="secondary"
            disabled={state.activity.status === "archived"}
            onClick={() => {
              setTitle(state.activity.title);
              setRenameOpen(true);
            }}
          >
            重命名
          </Button>
          {state.activity.status === "draft" ? (
            <Button variant="primary" disabled={activating} onClick={() => void activate()}>
              {activating ? "正在激活…" : "激活活动"}
            </Button>
          ) : null}
        </div>
      </header>
      {renameOpen ? (
        <div className="session-controls">
          <Input
            label="活动标题"
            className="session-control-field"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
          <Button
            variant="primary"
            disabled={renaming || title.trim() === ""}
            onClick={() => void rename()}
          >
            {renaming ? "正在保存…" : "保存标题"}
          </Button>
          <Button variant="secondary" disabled={renaming} onClick={() => setRenameOpen(false)}>
            取消
          </Button>
        </div>
      ) : null}
      {error === null ? null : (
        <p className="ui-field__error" role="alert">
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
