import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import {
  archiveArticle,
  createArticle,
  fetchManagedArticles,
  publishArticle,
  updateArticle,
  type ManagedArticle,
} from "../api/articles.js";
import { RequireSession } from "../auth/RequireSession.js";
import { useSession } from "../auth/SessionProvider.js";
import { Button } from "../components/ui/Button.js";
import { Card } from "../components/ui/Card.js";
import { Input } from "../components/ui/Input.js";
import { apiErrorText } from "../components/ui/apiError.js";

const EMPTY = { title: "", slug: "", summary: "", body: "", coverUrl: "" };

export function OpsArticlesPage() {
  return (
    <RequireSession>
      <OpsArticlesContent />
    </RequireSession>
  );
}

function OpsArticlesContent() {
  const { session } = useSession();
  const allowed =
    session?.actor.permissions.includes("*") === true ||
    session?.actor.permissions.includes("publishing.manage") === true ||
    session?.actor.permissions.includes("studio.manage") === true;
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ ...EMPTY });
  const [editing, setEditing] = useState<ManagedArticle | null>(null);
  const [error, setError] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ["managed-articles"],
    queryFn: fetchManagedArticles,
    enabled: allowed,
    retry: false,
  });

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ["managed-articles"] });
  };

  const save = useMutation({
    mutationFn: async () => {
      if (editing === null) {
        return await createArticle({
          title: form.title,
          ...(form.slug.trim() === "" ? {} : { slug: form.slug.trim() }),
          summary: form.summary,
          body: form.body,
          ...(form.coverUrl.trim() === "" ? {} : { coverUrl: form.coverUrl.trim() }),
        });
      }
      return await updateArticle(editing.id, {
        title: form.title,
        slug: form.slug.trim() === "" ? editing.slug : form.slug.trim(),
        summary: form.summary,
        body: form.body,
        ...(form.coverUrl.trim() === "" ? {} : { coverUrl: form.coverUrl.trim() }),
        expectedRevision: editing.revision,
      });
    },
    onSuccess: async (article) => {
      setEditing(article);
      setForm({
        title: article.title,
        slug: article.slug,
        summary: article.summary,
        body: article.body,
        coverUrl: article.coverUrl ?? "",
      });
      setError(null);
      await refresh();
    },
    onError: (caught) => setError(apiErrorText(caught, "操作失败。", "文章已被其他人修改，请刷新后重试。")),
  });

  const publish = useMutation({
    mutationFn: (article: ManagedArticle) => publishArticle(article.id, article.revision),
    onSuccess: async (article) => {
      setEditing(article);
      await refresh();
    },
    onError: (caught) => setError(apiErrorText(caught, "操作失败。", "文章已被其他人修改，请刷新后重试。")),
  });

  const archive = useMutation({
    mutationFn: (article: ManagedArticle) => archiveArticle(article.id, article.revision),
    onSuccess: async (article) => {
      setEditing(article);
      await refresh();
    },
    onError: (caught) => setError(apiErrorText(caught, "操作失败。", "文章已被其他人修改，请刷新后重试。")),
  });

  if (!allowed) {
    return <p className="form-error" role="alert">需要 publishing.manage 或 studio.manage 权限。</p>;
  }

  function startNew(): void {
    setEditing(null);
    setForm({ ...EMPTY });
    setError(null);
  }

  function startEdit(article: ManagedArticle): void {
    setEditing(article);
    setForm({
      title: article.title,
      slug: article.slug,
      summary: article.summary,
      body: article.body,
      coverUrl: article.coverUrl ?? "",
    });
    setError(null);
  }

  const articles = list.data ?? [];
  return (
    <section className="ops-page">
      <header className="ops-header">
        <div>
          <p className="eyebrow">ARTFLOW · CONTENT</p>
          <h1 className="ui-page-title">文章与往届风采</h1>
          <p className="ui-page-meta">发布后出现在公开的 /articles 页面。</p>
        </div>
        <Button variant="secondary" onClick={startNew}>新建文章</Button>
      </header>
      <div className="ops-grid">
        <Card>
          <h2 className="ui-card__title">文章列表</h2>
          {list.isPending ? <p className="auth-loading">正在加载…</p> : null}
          {list.error !== null ? <p className="form-error" role="alert">{apiErrorText(list.error, "文章列表暂时无法加载。", "刷新后重试。")}</p> : null}
          <ul className="seat-list">
            {articles.map((article) => (
              <li key={article.id}>
                <button type="button" className="table-link" onClick={() => startEdit(article)}>
                  {article.title}
                </button>
                <span> · {article.status === "published" ? "已发布" : article.status === "archived" ? "已归档" : "草稿"} · /{article.slug}</span>
                <Button variant="secondary" size="sm" onClick={() => publish.mutate(article)} disabled={publish.isPending || article.status === "published"}>
                  发布
                </Button>
                <Button variant="secondary" size="sm" onClick={() => archive.mutate(article)} disabled={archive.isPending || article.status === "archived"}>
                  归档
                </Button>
              </li>
            ))}
          </ul>
        </Card>

        <Card>
          <h2 className="ui-card__title">{editing === null ? "新建文章" : `编辑：${editing.title}`}</h2>
          <div className="auth-form">
            <Input label="标题" value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} maxLength={200} />
            <Input label="Slug（小写字母/数字/连字符）" value={form.slug} onChange={(event) => setForm({ ...form, slug: event.target.value })} maxLength={160} />
            <Input label="摘要" value={form.summary} onChange={(event) => setForm({ ...form, summary: event.target.value })} maxLength={500} />
            <Input label="封面图 URL（可选）" value={form.coverUrl} onChange={(event) => setForm({ ...form, coverUrl: event.target.value })} maxLength={2000} />
            <label className="ui-field">
              <span className="ui-field__label">正文</span>
              <textarea
                className="ui-input"
                rows={16}
                value={form.body}
                onChange={(event) => setForm({ ...form, body: event.target.value })}
                maxLength={100_000}
              />
            </label>
            {error === null ? null : <p className="ui-field__error" role="alert">{error}</p>}
            <Button variant="primary" onClick={() => save.mutate()} disabled={save.isPending || form.title.trim() === "" || form.body.trim() === ""}>
              {save.isPending ? "保存中…" : editing === null ? "创建草稿" : "保存修改"}
            </Button>
          </div>
          {editing === null || editing.status !== "published" ? null : (
            <p className="ui-card__description">
              公开地址：<a className="table-link" href={`/articles/${editing.slug}`} target="_blank" rel="noreferrer">/articles/{editing.slug}</a>
            </p>
          )}
        </Card>
      </div>
    </section>
  );
}
