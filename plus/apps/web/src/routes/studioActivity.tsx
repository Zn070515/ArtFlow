import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useState } from "react";

import {
  activateStudioActivity,
  duplicateStudioActivity,
  fetchStudioState,
  renameStudioActivity,
  type StudioState,
} from "../api/studio.js";
import { FormDialog } from "../components/ui/Dialog.js";
import { RequireSession } from "../auth/RequireSession.js";
import { hasStudioAccess, useSession } from "../auth/SessionProvider.js";
import { DefinitionEditor } from "../components/studio/DefinitionEditor.js";
import { ReleasePanel } from "../components/studio/ReleasePanel.js";
import { SessionPanel } from "../components/studio/SessionPanel.js";
import { Button } from "../components/ui/Button.js";
import { Card } from "../components/ui/Card.js";
import { apiErrorText } from "../components/ui/apiError.js";
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
  const navigate = useNavigate();
  const { session } = useSession();
  const queryClient = useQueryClient();
  const allowed = hasStudioAccess(session);
  const [activating, setActivating] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [duplicateOpen, setDuplicateOpen] = useState(false);
  const [duplicateTitle, setDuplicateTitle] = useState("");
  const [duplicating, setDuplicating] = useState(false);
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
      setError(apiErrorText(caught, "重命名失败，请稍后重试。", "活动已被其他操作更新，请刷新后重试。"));
    } finally {
      setRenaming(false);
    }
  }

  async function duplicate(): Promise<void> {
    setDuplicating(true);
    setError(null);
    try {
      const created = await duplicateStudioActivity(
        activityId,
        crypto.randomUUID(),
        duplicateTitle.trim() === "" ? undefined : duplicateTitle.trim(),
      );
      setDuplicateOpen(false);
      await navigate({
        to: "/studio/$activityId",
        params: { activityId: created.id },
      });
    } catch (caught) {
      setError(apiErrorText(caught, "复制活动失败，请稍后重试。", "源活动状态已变化，请刷新后重试。"));
    } finally {
      setDuplicating(false);
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
      setError(apiErrorText(caught, "激活失败，请稍后重试。", "活动状态已变化，请刷新后重试。"));
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
          <Link
            className="ui-button ui-button--secondary ui-button--md"
            to="/studio/$activityId/public"
            params={{ activityId }}
          >
            公开主页
          </Link>
          <Button
            variant="secondary"
            disabled={duplicating}
            onClick={() => {
              setDuplicateTitle("");
              setDuplicateOpen(true);
            }}
          >
            复制活动
          </Button>
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
      <FormDialog
        open={duplicateOpen}
        title="复制活动"
        description="复制能力组合与当前草稿；发布、报名、评分与结果不会被复制。"
        confirmLabel="复制"
        onCancel={() => setDuplicateOpen(false)}
        onConfirm={() => { void duplicate(); }}
      >
        <Input
          label="新活动标题（可选）"
          value={duplicateTitle}
          onChange={(event) => setDuplicateTitle(event.target.value)}
          hint="留空则使用“原标题（副本）”"
        />
      </FormDialog>
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
