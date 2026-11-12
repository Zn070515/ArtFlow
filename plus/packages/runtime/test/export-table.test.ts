import { randomUUID } from "node:crypto";

import { closeDb, createDb, migrate } from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import type { ActorContext } from "@artflow-plus/domain";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";

import {
  exportActivityTable,
  serializeCsv,
  type ExportTable,
} from "../src/export-service.js";
import type { RuntimeDeps } from "../src/deps.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_export_table_${Date.now()}_${process.pid}`;
const activityId = "act_export_table";

let db: Kysely<Database>;
let admin: Client;

const actor: ActorContext = {
  actorId: "export-table-staff",
  actorType: "user",
  roles: ["staff"],
  permissions: [
    "registration.review",
    "registration.manage",
    "competition.manage",
    "result.manage",
    "voting.manage",
  ],
};

const deps: RuntimeDeps = {
  actor,
  now: () => new Date(Date.UTC(2026, 11, 12, 10, 0, 0)).toISOString(),
  newEventId: () => randomUUID(),
};

describe.skipIf(!connectionString)("export table", () => {
  beforeAll(async () => {
    if (!connectionString) return;
    admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = createDb({ connectionString, schema });
    await migrate(db);
    await db.insertInto("activity").values({
      id: activityId,
      public_code: "TABLE001",
      title: "Table Export",
      status: "active",
      revision: 1,
      enabled_capabilities: JSON.stringify(["registration"]),
      active_definition_version: 1,
    }).execute();
    await db.insertInto("registration").values({
      id: "registration-table-1",
      activity_id: activityId,
      participant_id: "p-1",
      questionnaire_version: "v1",
      questionnaire_hash: "table-hash",
      status: "approved",
      answers: JSON.stringify({ name: "Alice", student_id: "20260001", song: "Song" }),
      revision: 1,
      review_note: "",
      reviewed_by: "export-table-staff",
      created_at: new Date(),
      updated_at: new Date(),
    }).execute();
  });

  afterAll(async () => {
    if (!connectionString) return;
    if (db !== undefined) await closeDb(db);
    if (admin !== undefined) {
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  });

  it("builds the same table shape for all four datasets", async () => {
    const registrations = await exportActivityTable(db, deps, { activityId, kind: "registrations" });
    expect(registrations).toMatchObject({
      activityId,
      kind: "registrations",
      title: "Table Export",
      filenameStem: `activity-${activityId}-registrations`,
      headers: ["participantId", "name", "studentId", "song", "status", "revision", "reviewNote"],
      rows: [["p-1", "Alice", "20260001", "Song", "approved", 1, ""]],
    });

    const materials = await exportActivityTable(db, deps, { activityId, kind: "materials" });
    expect(materials.headers).toEqual([
      "participantId",
      "questionKey",
      "originalName",
      "contentType",
      "byteLength",
      "status",
      "contentReady",
    ]);
    const scores = await exportActivityTable(db, deps, { activityId, kind: "scores" });
    expect(scores.headers).toEqual([
      "mode",
      "roundKey",
      "performanceId",
      "contestantId",
      "judgeId",
      "total",
      "source",
    ]);
    const votes = await exportActivityTable(db, deps, { activityId, kind: "votes" });
    expect(votes.headers).toEqual([
      "sessionId",
      "status",
      "optionId",
      "candidateId",
      "count",
      "totalBallots",
    ]);
    for (const table of [materials, scores, votes]) {
      expect(table.rows).toEqual([]);
      expect(table.filenameStem).toBe(`activity-${activityId}-${table.kind}`);
    }
  });
});

describe("CSV serialization", () => {
  const table: ExportTable = {
    activityId: "act_1",
    kind: "registrations",
    title: "CSV",
    filenameStem: "activity-act_1-registrations",
    headers: ["name", "note"],
    rows: [
      ["=HYPERLINK(\"http://evil\")", "plain"],
      ["Alice", "say \"hi\""],
      ["@SUM(A1)", "+1"],
    ],
  };

  it("quotes cells, doubles quotes, and neutralizes formula leads", () => {
    expect(serializeCsv(table)).toBe(
      [
        '"name","note"',
        "\"'=HYPERLINK(\"\"http://evil\"\")\",\"plain\"",
        '"Alice","say ""hi"""',
        "\"'@SUM(A1)\",\"'+1\"",
        "",
      ].join("\n"),
    );
  });

  it("always ends with a newline, including empty data", () => {
    expect(serializeCsv({ ...table, rows: [] })).toBe('"name","note"\n');
  });
});
