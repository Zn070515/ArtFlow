import { Type } from "@sinclair/typebox";

import type { StoredPublicArticle } from "@artflow-plus/db";
import {
  archivePublicArticle,
  createPublicArticle,
  getPublishedArticle,
  getPublishedArticles,
  listArticlesForManager,
  publishPublicArticle,
  updatePublicArticleContent,
} from "@artflow-plus/runtime";
import { DomainError } from "@artflow-plus/domain";

import type { ApiContext } from "../http/context.js";

const ArticleBody = Type.Object({
  slug: Type.Optional(Type.String({ maxLength: 160 })),
  title: Type.String({ minLength: 1, maxLength: 200 }),
  summary: Type.Optional(Type.String({ maxLength: 500 })),
  body: Type.String({ minLength: 1, maxLength: 100_000 }),
  coverUrl: Type.Optional(Type.String({ maxLength: 2000 })),
}, { additionalProperties: false });

const ArticleParams = Type.Object({ id: Type.String({ minLength: 1 }) }, { additionalProperties: false });
const SlugParams = Type.Object({ slug: Type.String({ minLength: 1, maxLength: 160 }) }, { additionalProperties: false });
const RevisionBody = Type.Object({ expectedRevision: Type.Integer({ minimum: 0 }) }, { additionalProperties: false });

function publicArticle(article: StoredPublicArticle, includeBody: boolean) {
  return {
    slug: article.slug,
    title: article.title,
    summary: article.summary,
    ...(article.coverUrl === undefined ? {} : { coverUrl: article.coverUrl }),
    publishedAt: article.publishedAt ?? article.createdAt,
    ...(includeBody ? { body: article.body } : {}),
  };
}

export function registerArticleRoutes(ctx: ApiContext): void {
  const { app, db, requestActor, requirePublicRateLimit } = ctx;

  app.get("/api/public/articles", { config: { access: "public" } }, async (request, reply) => {
    await requirePublicRateLimit(request, "public-articles", 60);
    reply.header("cache-control", "no-store");
    const articles = await getPublishedArticles(db);
    return { articles: articles.map((article) => publicArticle(article, false)) };
  });

  app.get("/api/public/articles/:slug", { schema: { params: SlugParams }, config: { access: "public" } }, async (request, reply) => {
    await requirePublicRateLimit(request, "public-article", 120);
    const { slug } = request.params as { slug: string };
    const article = await getPublishedArticle(db, slug);
    if (article === null) throw new DomainError("NOT_FOUND", "The article was not found.");
    reply.header("cache-control", "no-store");
    return publicArticle(article, true);
  });

  app.get("/api/articles", { config: { access: "session" } }, async (request) => {
    return { articles: await listArticlesForManager(db, await requestActor(request)) };
  });

  app.post("/api/articles", { schema: { body: ArticleBody } }, async (request, reply) => {
    const body = request.body as { slug?: string; title: string; summary?: string; body: string; coverUrl?: string };
    const article = await createPublicArticle(db, await requestActor(request), body);
    return reply.status(201).send({ article });
  });

  app.put("/api/articles/:id", { schema: { params: ArticleParams, body: Type.Intersect([ArticleBody, RevisionBody]) } }, async (request) => {
    const { id } = request.params as { id: string };
    const body = request.body as { slug?: string; title: string; summary?: string; body: string; coverUrl?: string; expectedRevision: number };
    const { expectedRevision, ...rest } = body;
    return { article: await updatePublicArticleContent(db, await requestActor(request), id, { ...rest, expectedRevision }) };
  });

  app.post("/api/articles/:id/publish", { schema: { params: ArticleParams, body: RevisionBody } }, async (request) => {
    const { id } = request.params as { id: string };
    const { expectedRevision } = request.body as { expectedRevision: number };
    return { article: await publishPublicArticle(db, await requestActor(request), id, expectedRevision) };
  });

  app.post("/api/articles/:id/archive", { schema: { params: ArticleParams, body: RevisionBody } }, async (request) => {
    const { id } = request.params as { id: string };
    const { expectedRevision } = request.body as { expectedRevision: number };
    return { article: await archivePublicArticle(db, await requestActor(request), id, expectedRevision) };
  });
}
