import type { Kysely, Selectable } from "kysely";

import type { Database, PublicArticleRow } from "./types.js";

export type PublicArticleStatus = "draft" | "published" | "archived";

export interface StoredPublicArticle {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly summary: string;
  readonly body: string;
  readonly coverUrl?: string;
  readonly status: PublicArticleStatus;
  readonly publishedAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revision: number;
  readonly authorId: string;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function article(row: Selectable<PublicArticleRow>): StoredPublicArticle {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    summary: row.summary,
    body: row.body,
    ...(row.cover_url === null ? {} : { coverUrl: row.cover_url }),
    status: row.status as PublicArticleStatus,
    ...(row.published_at === null ? {} : { publishedAt: iso(row.published_at) }),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    revision: row.revision,
    authorId: row.author_id,
  };
}

export async function listPublicArticles(
  db: Kysely<Database>,
  limit = 50,
): Promise<readonly StoredPublicArticle[]> {
  const rows = await db
    .selectFrom("public_article")
    .selectAll()
    .where("status", "=", "published")
    .orderBy("published_at", "desc")
    .orderBy("created_at", "desc")
    .limit(limit)
    .execute();
  return rows.map(article);
}

export async function listAllPublicArticles(
  db: Kysely<Database>,
): Promise<readonly StoredPublicArticle[]> {
  const rows = await db
    .selectFrom("public_article")
    .selectAll()
    .orderBy("updated_at", "desc")
    .execute();
  return rows.map(article);
}

export async function getPublicArticleBySlug(
  db: Kysely<Database>,
  slug: string,
): Promise<StoredPublicArticle | null> {
  const row = await db
    .selectFrom("public_article")
    .selectAll()
    .where("slug", "=", slug)
    .where("status", "=", "published")
    .executeTakeFirst();
  return row === undefined ? null : article(row);
}

export async function getPublicArticleById(
  db: Kysely<Database>,
  id: string,
): Promise<StoredPublicArticle | null> {
  const row = await db
    .selectFrom("public_article")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();
  return row === undefined ? null : article(row);
}

export interface NewPublicArticle {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly summary: string;
  readonly body: string;
  readonly coverUrl?: string;
  readonly authorId: string;
}

export async function insertPublicArticle(
  db: Kysely<Database>,
  input: NewPublicArticle,
): Promise<void> {
  await db
    .insertInto("public_article")
    .values({
      id: input.id,
      slug: input.slug,
      title: input.title,
      summary: input.summary,
      body: input.body,
      cover_url: input.coverUrl ?? null,
      status: "draft",
      published_at: null,
      created_at: new Date(),
      updated_at: new Date(),
      revision: 0,
      author_id: input.authorId,
    })
    .execute();
}

export interface PublicArticleEdit {
  readonly slug?: string;
  readonly title?: string;
  readonly summary?: string;
  readonly body?: string;
  readonly coverUrl?: string | null;
}

export async function updatePublicArticle(
  db: Kysely<Database>,
  id: string,
  expectedRevision: number,
  edit: PublicArticleEdit,
): Promise<boolean> {
  const result = await db
    .updateTable("public_article")
    .set({
      ...(edit.slug === undefined ? {} : { slug: edit.slug }),
      ...(edit.title === undefined ? {} : { title: edit.title }),
      ...(edit.summary === undefined ? {} : { summary: edit.summary }),
      ...(edit.body === undefined ? {} : { body: edit.body }),
      ...(edit.coverUrl === undefined ? {} : { cover_url: edit.coverUrl }),
      updated_at: new Date(),
      revision: expectedRevision + 1,
    })
    .where("id", "=", id)
    .where("revision", "=", expectedRevision)
    .returning("id")
    .executeTakeFirst();
  return result !== undefined;
}

export async function setPublicArticleStatus(
  db: Kysely<Database>,
  id: string,
  status: PublicArticleStatus,
  expectedRevision: number,
  publishedAt: Date | null,
): Promise<boolean> {
  const result = await db
    .updateTable("public_article")
    .set({
      status,
      published_at: publishedAt,
      updated_at: new Date(),
      revision: expectedRevision + 1,
    })
    .where("id", "=", id)
    .where("revision", "=", expectedRevision)
    .returning("id")
    .executeTakeFirst();
  return result !== undefined;
}
