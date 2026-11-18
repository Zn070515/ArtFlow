import { apiFetch } from "./client.js";

export interface PublicArticleSummary {
  readonly slug: string;
  readonly title: string;
  readonly summary: string;
  readonly coverUrl?: string;
  readonly publishedAt: string;
}

export interface PublicArticle extends PublicArticleSummary {
  readonly body: string;
}

export interface ManagedArticle {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly summary: string;
  readonly body: string;
  readonly coverUrl?: string;
  readonly status: "draft" | "published" | "archived";
  readonly publishedAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revision: number;
  readonly authorId: string;
}

export function fetchPublicArticles(signal?: AbortSignal): Promise<readonly PublicArticleSummary[]> {
  return apiFetch<{ articles: readonly PublicArticleSummary[] }>("/api/public/articles", { signal })
    .then((response) => response.articles);
}

export function fetchPublicArticle(slug: string, signal?: AbortSignal): Promise<PublicArticle> {
  return apiFetch<PublicArticle>(`/api/public/articles/${encodeURIComponent(slug)}`, { signal });
}

export function fetchManagedArticles(): Promise<readonly ManagedArticle[]> {
  return apiFetch<{ articles: readonly ManagedArticle[] }>("/api/articles")
    .then((response) => response.articles);
}

export interface ArticleDraft {
  readonly slug?: string;
  readonly title: string;
  readonly summary?: string;
  readonly body: string;
  readonly coverUrl?: string;
}

export function createArticle(input: ArticleDraft): Promise<ManagedArticle> {
  return apiFetch<{ article: ManagedArticle }>("/api/articles", {
    method: "POST",
    body: JSON.stringify(input),
  }).then((response) => response.article);
}

export function updateArticle(
  id: string,
  input: ArticleDraft & { readonly expectedRevision: number },
): Promise<ManagedArticle> {
  return apiFetch<{ article: ManagedArticle }>(`/api/articles/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify(input),
  }).then((response) => response.article);
}

export function publishArticle(id: string, expectedRevision: number): Promise<ManagedArticle> {
  return apiFetch<{ article: ManagedArticle }>(`/api/articles/${encodeURIComponent(id)}/publish`, {
    method: "POST",
    body: JSON.stringify({ expectedRevision }),
  }).then((response) => response.article);
}

export function archiveArticle(id: string, expectedRevision: number): Promise<ManagedArticle> {
  return apiFetch<{ article: ManagedArticle }>(`/api/articles/${encodeURIComponent(id)}/archive`, {
    method: "POST",
    body: JSON.stringify({ expectedRevision }),
  }).then((response) => response.article);
}
