import { randomUUID } from "node:crypto";

import { closeDb, createDb, insertLocalAccount, migrate } from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import { DomainError } from "@artflow-plus/domain";
import { hashPassword } from "@artflow-plus/runtime";
import type { DocumentExporter, RuntimeDeps } from "@artflow-plus/runtime";
import type { FastifyInstance } from "fastify";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Kysely } from "kysely";

import { buildApp } from "../src/app.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_exports_${Date.now()}_${process.pid}`;
const activityId = "act_export_activity";
const participantId = "p-export-1";

let app: FastifyInstance;
let db: Kysely<Database>;
let admin: Client;
let organizerToken = "";
let outsiderToken = "";

const deps: RuntimeDeps = {
  now: () => new Date(Date.UTC(2026, 11, 12, 10, 0, 0)).toISOString(),
  newEventId: () => randomUUID(),
};

function headers(token: string) {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

async function tokenFor(username: string, password: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/token",
    headers: { "content-type": "application/json" },
    payload: { username, password },
  });
  expect(response.statusCode).toBe(200);
  return (response.json() as { token: string }).token;
}

async function auditCount(): Promise<number> {
  const row = await db.selectFrom("audit_entry")
    .select((expression) => expression.fn.countAll<number>().as("count"))
    .where("activity_id", "=", activityId)
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

function fakeExporter(): DocumentExporter & { render: ReturnType<typeof vi.fn> } {
  return {
    render: vi.fn(async (input) => ({
      bytes: Buffer.from(`rendered:${input.format}`),
      contentType: input.format === "docx"
        ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      extension: input.format,
    })),
  };
}

async function buildTestApp(exporter: DocumentExporter | null): Promise<FastifyInstance> {
  return buildApp({ db, deps, enableRuntimeFacts: true, documentExporter: exporter });
}

describe.skipIf(!connectionString)("controlled document exports", () => {
  beforeAll(async () => {
    if (!connectionString) return;
    admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = createDb({ connectionString, schema });
    await migrate(db);
    await insertLocalAccount(db, {
      username: "export-organizer",
      passwordDigest: hashPassword("export-organizer-pass"),
      actor: {
        actorId: "export-organizer",
        actorType: "user",
        roles: ["staff"],
        permissions: ["registration.review"],
      },
      active: true,
    });
    await insertLocalAccount(db, {
      username: "export-outsider",
      passwordDigest: hashPassword("export-outsider-pass"),
      actor: {
        actorId: "export-outsider",
        actorType: "user",
        roles: ["participant"],
        permissions: [],
      },
      active: true,
    });
    await db.insertInto("activity").values({
      id: activityId,
      public_code: "EXPORT01",
      title: "Export Activity",
      status: "active",
      revision: 1,
      enabled_capabilities: JSON.stringify(["registration"]),
      active_definition_version: 1,
    }).execute();
    await db.insertInto("registration").values({
      id: "registration-export-1",
      activity_id: activityId,
      participant_id: participantId,
      questionnaire_version: "v1",
      questionnaire_hash: "export-questionnaire",
      status: "approved",
      answers: JSON.stringify({
        name: "Alice",
        student_id: "20260001",
        song: "Export Song",
      }),
      revision: 2,
      review_note: "",
      reviewed_by: "export-organizer",
      created_at: new Date(),
      updated_at: new Date(),
    }).execute();

    app = await buildTestApp(fakeExporter());
    await app.ready();
    organizerToken = await tokenFor("export-organizer", "export-organizer-pass");
    outsiderToken = await tokenFor("export-outsider", "export-outsider-pass");
  });

  afterAll(async () => {
    if (!connectionString) return;
    if (app !== undefined) await app.close();
    if (db !== undefined) await closeDb(db);
    if (admin !== undefined) {
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  });

  it("keeps the CSV export and writes one audit entry", async () => {
    const before = await auditCount();
    const response = await app.inject({
      method: "GET",
      url: `/api/activities/${activityId}/exports/registrations`,
      headers: headers(organizerToken),
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("text/csv; charset=utf-8");
    expect(response.headers["content-disposition"]).toBe(
      `attachment; filename="activity-${activityId}-registrations.csv"`,
    );
    expect(response.body).toContain(
      '"participantId","name","studentId","song","status","revision","reviewNote"',
    );
    expect(response.body).toContain(
      `"${participantId}","Alice","20260001","Export Song","approved","2",""`,
    );
    expect(await auditCount()).toBe(before + 1);
  });

  it("renders DOCX and XLSX from the same table", async () => {
    for (const format of ["docx", "xlsx"] as const) {
      const exporter = fakeExporter();
      const scoped = await buildTestApp(exporter);
      try {
        const before = await auditCount();
        const response = await scoped.inject({
          method: "GET",
          url: `/api/activities/${activityId}/exports/registrations?format=${format}`,
          headers: headers(organizerToken),
        });
        expect(response.statusCode).toBe(200);
        expect(response.headers["content-type"]).toBe(
          format === "docx"
            ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        );
        expect(response.headers["content-disposition"]).toBe(
          `attachment; filename="activity-${activityId}-registrations.${format}"`,
        );
        expect(exporter.render).toHaveBeenCalledWith({
          format,
          title: "Export Activity",
          filenameStem: `activity-${activityId}-registrations`,
          headers: [
            "participantId",
            "name",
            "studentId",
            "song",
            "status",
            "revision",
            "reviewNote",
          ],
          rows: [[participantId, "Alice", "20260001", "Export Song", "approved", 2, ""]],
        });
        expect(await auditCount()).toBe(before + 1);
      } finally {
        await scoped.close();
      }
    }
  });

  it("fails closed when the renderer is not configured", async () => {
    const scoped = await buildTestApp(null);
    try {
      const before = await auditCount();
      const response = await scoped.inject({
        method: "GET",
        url: `/api/activities/${activityId}/exports/registrations?format=docx`,
        headers: headers(organizerToken),
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ code: "EXPORT_UNAVAILABLE" });
      expect(await auditCount()).toBe(before);
    } finally {
      await scoped.close();
    }
  });

  it("fails closed when the renderer rejects, without an audit entry", async () => {
    const exporter: DocumentExporter = {
      render: vi.fn(async () => {
        throw new DomainError("EXPORT_UNAVAILABLE", "The document export service is unavailable.");
      }),
    };
    const scoped = await buildTestApp(exporter);
    try {
      const before = await auditCount();
      const response = await scoped.inject({
        method: "GET",
        url: `/api/activities/${activityId}/exports/registrations?format=xlsx`,
        headers: headers(organizerToken),
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ code: "EXPORT_UNAVAILABLE" });
      expect(await auditCount()).toBe(before);
    } finally {
      await scoped.close();
    }
  });

  it("keeps the permission check before any read or render", async () => {
    const exporter = fakeExporter();
    const scoped = await buildTestApp(exporter);
    try {
      const before = await auditCount();
      const response = await scoped.inject({
        method: "GET",
        url: `/api/activities/${activityId}/exports/registrations?format=docx`,
        headers: headers(outsiderToken),
      });
      expect(response.statusCode).toBe(403);
      expect(exporter.render).not.toHaveBeenCalled();
      expect(await auditCount()).toBe(before);
    } finally {
      await scoped.close();
    }
  });
});
