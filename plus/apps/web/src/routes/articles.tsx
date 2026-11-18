import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect } from "react";

import { fetchPublicArticles } from "../api/articles.js";
import { ErrorState } from "../components/ui/ErrorState.js";
import { EmptyState } from "../components/ui/EmptyState.js";

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium" }).format(new Date(value));
}

export function ArticlesPage() {
  const query = useQuery({
    queryKey: ["public-articles"],
    queryFn: ({ signal }) => fetchPublicArticles(signal),
    retry: false,
    staleTime: 60_000,
  });

  useEffect(() => {
    document.title = "文章与往届风采 · ArtFlow";
  }, []);

  if (query.isPending) return <p className="me-state">正在加载文章…</p>;
  if (query.error !== null) return <ErrorState description="文章暂时无法加载。" onRetry={() => void query.refetch()} />;
  const articles = query.data ?? [];

  return (
    <section className="articles-page">
      <header className="articles-header">
        <p className="eyebrow">ARTFLOW · STORIES</p>
        <h1 className="ui-page-title">文章与往届风采</h1>
        <p className="ui-page-meta">活动回顾、公告与舞台背后的故事。</p>
      </header>
      {articles.length === 0 ? (
        <EmptyState title="还没有公开文章" description="主办方发布后，这里会出现活动回顾与往届风采。" />
      ) : (
        <div className="articles-grid">
          {articles.map((article) => (
            <article className="article-card" key={article.slug}>
              {article.coverUrl === undefined ? null : (
                <img className="article-card__cover" src={article.coverUrl} alt="" loading="lazy" />
              )}
              <p className="article-card__date">{formatDate(article.publishedAt)}</p>
              <h2 className="article-card__title">
                <Link to="/articles/$slug" params={{ slug: article.slug }}>{article.title}</Link>
              </h2>
              <p className="article-card__summary">{article.summary}</p>
            </article>
          ))}
        </div>
      )}
      <Link className="auth-switch" to="/events">浏览公开活动</Link>
    </section>
  );
}
