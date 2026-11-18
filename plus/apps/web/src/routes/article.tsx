import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { useEffect } from "react";

import { fetchPublicArticle } from "../api/articles.js";
import { ErrorState } from "../components/ui/ErrorState.js";

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium" }).format(new Date(value));
}

export function ArticlePage() {
  const { slug } = useParams({ from: "/articles/$slug" });
  const query = useQuery({
    queryKey: ["public-article", slug],
    queryFn: ({ signal }) => fetchPublicArticle(slug, signal),
    retry: false,
    staleTime: 60_000,
  });

  useEffect(() => {
    document.title = query.data === undefined ? "文章 · ArtFlow" : `${query.data.title} · ArtFlow`;
  }, [query.data]);

  if (query.isPending) return <p className="me-state">正在加载文章…</p>;
  if (query.error !== null) return <ErrorState description="文章不存在或尚未发布。" onRetry={() => void query.refetch()} />;
  const article = query.data;
  if (article === undefined) return null;

  return (
    <article className="article-page">
      <Link className="auth-switch" to="/articles">← 返回文章列表</Link>
      <header>
        <p className="article-card__date">{formatDate(article.publishedAt)}</p>
        <h1 className="ui-page-title">{article.title}</h1>
        {article.summary === "" ? null : <p className="ui-page-meta">{article.summary}</p>}
      </header>
      {article.coverUrl === undefined ? null : (
        <img className="article-page__cover" src={article.coverUrl} alt="" />
      )}
      <div className="article-page__body">{article.body}</div>
    </article>
  );
}
