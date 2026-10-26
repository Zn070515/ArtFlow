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
    return <p className="form-error" role="alert">当前账号缺少 studio.manage。</p>;
  }
  if (packsQuery.isPending) return <p className="auth-loading">正在加载 Pack…</p>;
  if (packsQuery.error !== null) {
    return <p className="form-error" role="alert">Pack 列表暂时无法加载。</p>;
  }

  return (
    <section className="studio-page">
      <header className="studio-header">
        <div>
          <p className="eyebrow">STUDIO · 新建</p>
          <h1 className="display results-title">新建活动</h1>
        </div>
      </header>
      <div className="studio-grid">
        <section className="ops-card">
          <h2>Guided Mode</h2>
          <label className="field">
            <span>活动标题</span>
            <input value={title} onChange={(event) => setTitle(event.target.value)} />
          </label>
          <label className="field">
            <span>Activity Pack</span>
            <select value={pack?.identity ?? ""} onChange={(event) => setPackId(event.target.value)}>
              {packs.map((candidate) => (
                <option key={candidate.identity} value={candidate.identity}>
                  {candidate.title}
                </option>
              ))}
            </select>
          </label>
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
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div className="studio-toolbar">
            <button className="secondary-button" type="button" onClick={() => void doPreview()}>
              预览定义
            </button>
            <button className="primary-button" type="button" disabled={busy} onClick={() => void create()}>
              {busy ? "正在创建…" : "创建活动"}
            </button>
          </div>
        </section>
        <section className="ops-card">
          <p className="eyebrow">PREVIEW</p>
          <h2>生成的组合</h2>
          {preview === null ? (
            <p className="state-copy">点击“预览定义”查看 enabled capabilities 与生成的 Package。</p>
          ) : (
            <>
              <p className="state-copy">
                {preview.enabledCapabilities.join(", ")}
              </p>
              <pre className="preview-json">{JSON.stringify(preview.definition, null, 2)}</pre>
            </>
          )}
        </section>
      </div>
    </section>
  );
}
