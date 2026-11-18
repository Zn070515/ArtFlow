import { randomUUID } from "node:crypto";

import { closeDb, createDb, migrate, readActivityAnalytics } from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import type { ActorContext } from "@artflow-plus/domain";
import { Client } from "pg";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { getOperationsRiskBoard } from "../src/operations-risk-service.js";
import type { RuntimeDeps } from "../src/deps.js";

vi.mock("@artflow-plus/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@artflow-plus/db")>();
  return { ...actual, readActivityAnalytics: vi.fn(actual.readActivityAnalytics) };
});

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_operations_risk_${Date.now()}_${process.pid}`;
let db: Kysely<Database>;
let admin: Client;

const actor: ActorContext = {
  actorId: "risk-staff",
  actorType: "user",
  roles: ["staff"],
  permissions: ["registration.review"],
};

function deps(permissions: readonly string[] = ["registration.review"]): RuntimeDeps {
  return {
    actor: { ...actor, permissions },
    now: () => "2026-11-18T10:00:00.000Z",
    newEventId: () => randomUUID(),
  };
}

async function seedActivity(
  id: string,
  title: string,
  status: "active" | "closed" | "archived",
  capabilities: readonly string[],
): Promise<string> {
  await db.insertInto("activity").values({
    id,
    public_code: `RISK-${id}`,
    title,
    status,
    revision: 1,
    enabled_capabilities: JSON.stringify(capabilities),
    active_definition_version: 1,
  }).execute();
  return id;
}

describe.skipIf(!connectionString)("operations risk board", () => {
  beforeAll(async () => {
    if (connectionString === undefined) return;
    admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = createDb({ connectionString, schema });
    await migrate(db);

    await seedActivity("risk-a", "报名待审", "active", ["registration", "questionnaire"]);
    await seedActivity("risk-b", "比赛准备", "active", ["registration", "questionnaire", "competition"]);
    await seedActivity("risk-c", "关闭未归档", "closed", ["archive"]);
    await seedActivity("risk-d", "已归档", "archived", ["archive"]);

    await db.insertInto("registration").values({
      id: "risk-registration-1",
      activity_id: "risk-a",
      participant_id: "risk-participant-1",
      questionnaire_version: "v1",
      questionnaire_hash: "hash",
      status: "submitted",
      answers: JSON.stringify({ name: "选手甲" }),
      supplement_keys: JSON.stringify([]),
      revision: 0,
      review_note: "",
      reviewed_by: null,
    }).execute();
  });

  afterAll(async () => {
    if (connectionString === undefined) return;
    await closeDb(db);
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });

  it("returns non-archived activities with their attention codes", async () => {
    const view = await getOperationsRiskBoard(db, deps());
    expect(view.activities).toHaveLength(3);
    const byId = new Map(view.activities.map((row) => [row.activity.id, row]));

    expect(byId.get("risk-a")?.attention).toContainEqual({
      code: "REGISTRATION_REVIEW_PENDING",
      count: 1,
    });
    expect(byId.get("risk-a")?.attention).toContainEqual({ code: "ROSTER_NOT_FINAL" });
    expect(byId.get("risk-c")?.attention).toContainEqual({ code: "ARCHIVE_MISSING" });
    expect(byId.has("risk-d")).toBe(false);
  });

  it("requires an analytics permission", async () => {
    await expect(getOperationsRiskBoard(db, deps(["tasks.manage"])))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("fails the whole board when one activity cannot be read", async () => {
    vi.mocked(readActivityAnalytics).mockRejectedValueOnce(new Error("analytics unavailable"));
    await expect(getOperationsRiskBoard(db, deps())).rejects.toThrow("analytics unavailable");
  });
});
