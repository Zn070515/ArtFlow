import { randomUUID } from "node:crypto";

import type { Database, StoredPublicArticle } from "@artflow-plus/db";
import {
  getPublicArticleById,
  getPublicArticleBySlug,
  insertAudit,
  insertPublicArticle,
  listAllPublicArticles,
  listPublicArticles,
  setPublicArticleStatus,
  updatePublicArticle,
} from "@artflow-plus/db";
import { DomainError, hasPermission } from "@artflow-plus/domain";
import type { ActorContext } from "@artflow-plus/domain";
import type { Kysely } from "kysely";

export interface ArticleInput {
  readonly slug?: string;
  readonly title: string;
  readonly summary?: string;
  readonly body: string;
  readonly coverUrl?: string;
}

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_TITLE = 200;
const MAX_BODY = 100_000;

function canManage(actor: ActorContext): boolean {
  return hasPermission(actor, "publishing.manage") || hasPermission(actor, "studio.manage");
}

function requireManager(actor: ActorContext): void {
  if (!canManage(actor)) {
    throw new DomainError("FORBIDDEN", "A publishing or studio permission is required.");
  }
}

function slugify(value: string): string {
  const base = value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  return base.length >= 3 ? base : `article-${randomUUID().slice(0, 8)}`;
}

function normalizeSlug(value: string | undefined, title: string): string {
  const slug = (value === undefined || value.trim() === "" ? slugify(title) : value.trim().toLowerCase());
  if (!SLUG_PATTERN.test(slug) || slug.length > 160) {
    throw new DomainError("INVALID_INPUT", "Slug must be lowercase letters, numbers and single dashes.");
  }
  return slug;
}

function normalizeCover(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("unsupported protocol");
    }
    return url.toString();
  } catch {
    throw new DomainError("INVALID_INPUT", "Cover URL must be an http(s) URL.");
  }
}

function normalizeText(input: ArticleInput): { title: string; summary: string; body: string } {
  const title = input.title.trim();
  const body = input.body.trim();
  if (title === "" || title.length > MAX_TITLE) {
    throw new DomainError("INVALID_INPUT", "Title must be 1-200 characters.");
  }
  if (body === "" || body.length > MAX_BODY) {
    throw new DomainError("INVALID_INPUT", "Article body must be 1-100000 characters.");
  }
  return {
    title,
    body,
    summary: (input.summary ?? "").trim().slice(0, 500),
  };
}

async function audit(
  db: Kysely<Database>,
  actor: ActorContext,
  commandType: string,
  detail: Record<string, unknown>,
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await insertAudit(trx, {
      commandId: `article-${randomUUID()}`,
      activityId: null,
      capability: "publishing",
      commandType,
      actor,
      detail,
    });
  });
}

export async function createPublicArticle(
  db: Kysely<Database>,
  actor: ActorContext,
  input: ArticleInput,
): Promise<StoredPublicArticle> {
  requireManager(actor);
  const text = normalizeText(input);
  const slug = normalizeSlug(input.slug, text.title);
  const coverUrl = normalizeCover(input.coverUrl);
  const id = `article-${randomUUID()}`;
  try {
    await insertPublicArticle(db, {
      id,
      slug,
      ...text,
      ...(coverUrl === undefined ? {} : { coverUrl }),
      authorId: actor.actorId,
    });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "23505") {
      throw new DomainError("SLUG_TAKEN", "This slug is already used by another article.");
    }
    throw error;
  }
  const created = await getPublicArticleById(db, id);
  if (created === null) throw new DomainError("NOT_FOUND", "The article was not created.");
  await audit(db, actor, "article.create", { id, slug });
  return created;
}

export async function updatePublicArticleContent(
  db: Kysely<Database>,
  actor: ActorContext,
  id: string,
  input: ArticleInput & { readonly expectedRevision: number },
): Promise<StoredPublicArticle> {
  requireManager(actor);
  const current = await getPublicArticleById(db, id);
  if (current === null) throw new DomainError("NOT_FOUND", "The article was not found.");
  if (current.status === "archived") {
    throw new DomainError("ARTICLE_ARCHIVED", "Archived articles are read-only.");
  }
  const text = normalizeText(input);
  const slug = normalizeSlug(input.slug ?? current.slug, text.title);
  const coverUrl = input.coverUrl === undefined
    ? undefined
    : normalizeCover(input.coverUrl) ?? null;
  try {
    const updated = await updatePublicArticle(db, id, input.expectedRevision, {
      slug,
      ...text,
      ...(coverUrl === undefined ? {} : { coverUrl }),
    });
    if (!updated) throw new DomainError("STALE_REVISION", "The article changed since it was read.");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "23505") {
      throw new DomainError("SLUG_TAKEN", "This slug is already used by another article.");
    }
    throw error;
  }
  const saved = await getPublicArticleById(db, id);
  if (saved === null) throw new DomainError("NOT_FOUND", "The article was not found.");
  await audit(db, actor, "article.update", { id, slug });
  return saved;
}

export async function publishPublicArticle(
  db: Kysely<Database>,
  actor: ActorContext,
  id: string,
  expectedRevision: number,
): Promise<StoredPublicArticle> {
  requireManager(actor);
  const current = await getPublicArticleById(db, id);
  if (current === null) throw new DomainError("NOT_FOUND", "The article was not found.");
  const published = await setPublicArticleStatus(
    db,
    id,
    "published",
    expectedRevision,
    current.publishedAt === undefined ? new Date() : new Date(current.publishedAt),
  );
  if (!published) throw new DomainError("STALE_REVISION", "The article changed since it was read.");
  const saved = await getPublicArticleById(db, id);
  if (saved === null) throw new DomainError("NOT_FOUND", "The article was not found.");
  await audit(db, actor, "article.publish", { id, slug: current.slug });
  return saved;
}

export async function archivePublicArticle(
  db: Kysely<Database>,
  actor: ActorContext,
  id: string,
  expectedRevision: number,
): Promise<StoredPublicArticle> {
  requireManager(actor);
  const current = await getPublicArticleById(db, id);
  if (current === null) throw new DomainError("NOT_FOUND", "The article was not found.");
  const archived = await setPublicArticleStatus(db, id, "archived", expectedRevision, null);
  if (!archived) throw new DomainError("STALE_REVISION", "The article changed since it was read.");
  const saved = await getPublicArticleById(db, id);
  if (saved === null) throw new DomainError("NOT_FOUND", "The article was not found.");
  await audit(db, actor, "article.archive", { id, slug: current.slug });
  return saved;
}

export async function getPublishedArticles(db: Kysely<Database>): Promise<readonly StoredPublicArticle[]> {
  return await listPublicArticles(db);
}

export async function getPublishedArticle(
  db: Kysely<Database>,
  slug: string,
): Promise<StoredPublicArticle | null> {
  return await getPublicArticleBySlug(db, slug);
}

export async function listArticlesForManager(
  db: Kysely<Database>,
  actor: ActorContext,
): Promise<readonly StoredPublicArticle[]> {
  requireManager(actor);
  return await listAllPublicArticles(db);
}
