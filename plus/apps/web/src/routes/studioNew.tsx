import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { ApiError } from "../api/client.js";
import {
  createStudioActivity,
  fetchPacks,
  previewPack,
  type PackPreview,
} from "../api/studio.js";
import { RequireSession } from "../auth/RequireSession.js";
import { hasStudioAccess, useSession } from "../auth/SessionProvider.js";
import { summarizeDefinition } from "../components/studio/definitionSummary.js";
import { Button } from "../components/ui/Button.js";
import { Card } from "../components/ui/Card.js";
import { EmptyState } from "../components/ui/EmptyState.js";
import { ErrorState } from "../components/ui/ErrorState.js";
import { Input } from "../components/ui/Input.js";
import { Select } from "../components/ui/Select.js";

function SummarySection({
  title,
  items,
}: {
  readonly title: string;
  readonly items: readonly string[];
}) {
  if (items.length === 0) return null;
  return (
    <section className="definition-summary-section">
      <h3>{title}</h3>
      <ul>
        {items.map((item, index) => (
          <li key={`${title}-${index}`}>{item}</li>
        ))}
      </ul>
    </section>
  );
}

export function StudioNewPage() {
  return (
    <RequireSession>
      <StudioNewContent />
    </RequireSession>
  );
}

function StudioNewContent() {
  const { session } = useSession();
  const allowed = hasStudioAccess(session);
  const navigate = useNavigate();
  const packsQuery = useQuery({
    queryKey: ["packs"],
    queryFn: fetchPacks,
    enabled: allowed,
    retry: false,
  });
  const [title, setTitle] = useState("");
  const [packId, setPackId] = useState("");
  const [answers, setAnswers] = useState<Record<string, boolean>>({});
  const [preview, setPreview] = useState<PackPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const initializedPack = useRef("");

  const packs = packsQuery.data ?? [];
  const pack = packs.find((candidate) => candidate.identity === packId) ?? packs[0];

  useEffect(() => {
    if (pack === undefined) return;
    if (packId !== pack.identity) setPackId(pack.identity);
    if (initializedPack.current === pack.identity) return;
    initializedPack.current = pack.identity;
    setAnswers(Object.fromEntries(pack.questions.map((question) => [question.id, question.default])));
    setPreview(null);
  }, [pack, packId]);

  async function doPreview(): Promise<void> {
    if (pack === undefined) return;
    setError(null);
    try {
      setPreview(await previewPack(pack.identity, { title: title || pack.title, answers }));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "预览失败。");
    }
  }

  async function create(): Promise<void> {
    if (pack === undefined) return;
    if (!title.trim()) {
      setError("请填写活动标题");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const activity = await createStudioActivity(crypto.randomUUID(), {
        title: title.trim(),
        packId: pack.identity,
        answers,
      });
      await navigate({ to: "/studio/$activityId", params: { activityId: activity.id } });
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "创建失败，请稍后重试。");
    } finally {
      setBusy(false);
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
  if (packsQuery.isPending) return <p className="auth-loading">正在加载 Pack…</p>;
  if (packsQuery.error !== null) {
    return (
      <ErrorState
        description="Pack 列表暂时无法加载。"
        onRetry={() => { void packsQuery.refetch(); }}
      />
    );
  }

  const summary = summarizeDefinition(preview?.definition, preview?.enabledCapabilities ?? []);

  return (
    <section className="studio-page">
      <header className="studio-header">
        <h1 className="ui-page-title">新建活动</h1>
      </header>
      <div className="studio-grid">
        <Card className="studio-main-column">
          <h2 className="ui-card__title">Guided Mode</h2>
          <Input
            label="活动标题"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
          <Select
            label="Activity Pack"
            value={pack?.identity ?? ""}
            onChange={(event) => setPackId(event.target.value)}
          >
            {packs.map((candidate) => (
              <option key={candidate.identity} value={candidate.identity}>
                {candidate.title}
              </option>
            ))}
          </Select>
          {pack === undefined ? null : (
            <div className="pack-questions">
              {pack.questions.map((question) => (
                <label className="pack-question" key={question.id}>
                  <input
                    type="checkbox"
                    checked={answers[question.id] ?? question.default}
                    onChange={(event) =>
                      setAnswers((current) => ({ ...current, [question.id]: event.target.checked }))
                    }
                  />
                  <span>{question.prompt}</span>
                  <small>{question.capability}</small>
                </label>
              ))}
            </div>
          )}
          {error === null ? null : (
            <p className="ui-field__error" role="alert">
              {error}
            </p>
          )}
          <div className="studio-toolbar">
            <Button variant="secondary" onClick={() => void doPreview()}>
              预览定义
            </Button>
            <Button variant="primary" disabled={busy} onClick={() => void create()}>
              {busy ? "正在创建…" : "创建活动"}
            </Button>
          </div>
        </Card>
        <Card className="studio-rail">
          <h2 className="ui-card__title">生成的组合</h2>
          {preview === null ? (
            <p className="ui-card__description">点击“预览定义”查看启用的能力与规则摘要。</p>
          ) : (
            <>
              <p className="ui-card__description">
                已启用：{preview.enabledCapabilities.join("、")}
              </p>
              <div className="definition-summary">
                <SummarySection title="报名字段" items={summary.registration} />
                <SummarySection title="回合与评委" items={summary.rounds} />
                <SummarySection title="评分方式" items={summary.scoring} />
                <SummarySection title="材料限制" items={summary.materials} />
                <SummarySection title="发布阶段" items={summary.publishing} />
                <SummarySection title="投票" items={summary.voting} />
              </div>
              <details className="definition-raw">
                <summary>高级：原始 JSON</summary>
                <pre className="preview-json">{JSON.stringify(preview.definition, null, 2)}</pre>
              </details>
            </>
          )}
        </Card>
      </div>
    </section>
  );
}
