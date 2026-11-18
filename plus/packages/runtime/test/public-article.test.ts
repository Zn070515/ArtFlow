import { closeDb, createDb, migrate } from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import type { ActorContext } from "@artflow-plus/domain";
import { Client } from "pg";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  archivePublicArticle,
  createPublicArticle,
  getPublishedArticle,
  getPublishedArticles,
  publishPublicArticle,
  updatePublicArticleContent,
} from "../src/index.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_public_article_${Date.now()}_${process.pid}`;

let db: Kysely<Database>;
let admin: Client;

const editor: ActorContext = {
  actorId: "editor-1",
  actorType: "user",
  roles: ["staff"],
  permissions: ["publishing.manage"],
};
const outsider: ActorContext = {
  actorId: "outsider-1",
  actorType: "user",
  roles: ["participant"],
  permissions: [],
};

describe.skipIf(!connectionString)("public articles", () => {
  beforeAll(async () => {
    if (!connectionString) return;
    admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = createDb({ connectionString, schema });
    await migrate(db);
  });

  afterAll(async () => {
    if (!connectionString) return;
    await closeDb(db);
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });

  it("creates, publishes, updates and archives an article", async () => {
    const created = await createPublicArticle(db, editor, {
      title: "Spring Gala 2026",
      summary: "A night of songs",
      body: "First paragraph.\n\nSecond paragraph.",
      coverUrl: "https://example.com/cover.jpg",
    });
    expect(created.slug).toBe("spring-gala-2026");
    expect(created.status).toBe("draft");
    expect(await getPublishedArticle(db, created.slug)).toBeNull();

    const published = await publishPublicArticle(db, editor, created.id, created.revision);
    expect(published.status).toBe("published");
    expect(published.publishedAt).toEqual(expect.any(String));
    expect((await getPublishedArticles(db))[0]?.slug).toBe(created.slug);

    const updated = await updatePublicArticleContent(db, editor, created.id, {
      title: "Spring Gala 2026 · Recap",
      body: "Updated body.",
      expectedRevision: published.revision,
    });
    expect(updated.title).toContain("Recap");
    await expect(updatePublicArticleContent(db, editor, created.id, {
      title: "stale",
      body: "stale",
      expectedRevision: published.revision,
    })).rejects.toMatchObject({ code: "STALE_REVISION" });

    const archived = await archivePublicArticle(db, editor, created.id, updated.revision);
    expect(archived.status).toBe("archived");
    expect(await getPublishedArticle(db, created.slug)).toBeNull();
  });

  it("requires a manager and a unique slug", async () => {
    await expect(createPublicArticle(db, outsider, {
      title: "Nope",
      body: "Nope",
    })).rejects.toMatchObject({ code: "FORBIDDEN" });

    await createPublicArticle(db, editor, {
      slug: "same-slug",
      title: "One",
      body: "One",
    });
    await expect(createPublicArticle(db, editor, {
      slug: "same-slug",
      title: "Two",
      body: "Two",
    })).rejects.toMatchObject({ code: "SLUG_TAKEN" });
  });
});
