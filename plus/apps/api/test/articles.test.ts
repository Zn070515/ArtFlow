import { randomUUID } from "node:crypto";

import { closeDb, createDb, insertLocalAccount, migrate } from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import { hashPassword, MemoryRateLimiter } from "@artflow-plus/runtime";
import type { RuntimeDeps } from "@artflow-plus/runtime";
import type { FastifyInstance } from "fastify";
import { Client } from "pg";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_api_articles_${Date.now()}_${process.pid}`;

let db: Kysely<Database>;
let admin: Client;
let app: FastifyInstance;
let token = "";

const deps: RuntimeDeps = {
  now: () => new Date().toISOString(),
  newEventId: () => randomUUID(),
};

const headers = { "content-type": "application/json" };

describe.skipIf(!connectionString)("public article API", () => {
  beforeAll(async () => {
    if (!connectionString) return;
    admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = createDb({ connectionString, schema });
    await migrate(db);
    app = await buildApp({ db, deps, rateLimiter: new MemoryRateLimiter() });
    await app.ready();
    await insertLocalAccount(db, {
      username: "article-editor",
      passwordDigest: hashPassword("article-editor-password"),
      actor: {
        actorId: "article-editor",
        actorType: "user",
        roles: ["staff"],
        permissions: ["publishing.manage"],
      },
      active: true,
    });
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/token",
      headers,
      payload: { username: "article-editor", password: "article-editor-password" },
    });
    token = login.json().token as string;
  });

  afterAll(async () => {
    if (!connectionString) return;
    await app.close();
    await closeDb(db);
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });

  it("publishes an article and exposes only the public view", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/articles",
      headers: { ...headers, authorization: `Bearer ${token}` },
      payload: {
        slug: "spring-recap",
        title: "春季回顾",
        summary: "一晚的歌",
        body: "第一段。\n\n第二段。",
      },
    });
    expect(created.statusCode).toBe(201);
    const article = created.json().article as { id: string; revision: number };
    const published = await app.inject({
      method: "POST",
      url: `/api/articles/${article.id}/publish`,
      headers: { ...headers, authorization: `Bearer ${token}` },
      payload: { expectedRevision: article.revision },
    });
    expect(published.statusCode).toBe(200);

    const list = await app.inject({ method: "GET", url: "/api/public/articles" });
    expect(list.statusCode).toBe(200);
    expect(list.json().articles).toEqual([
      expect.objectContaining({ slug: "spring-recap", title: "春季回顾" }),
    ]);
    expect(list.json().articles[0].body).toBeUndefined();

    const detail = await app.inject({ method: "GET", url: "/api/public/articles/spring-recap" });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().body).toContain("第二段");
    expect(detail.json().id).toBeUndefined();

    const forbidden = await app.inject({ method: "GET", url: "/api/articles" });
    expect(forbidden.statusCode).toBe(401);
  });
});
