import { activateActivity, createActivity } from "@artflow-plus/domain";
import type { Kysely } from "kysely";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  closeDb,
  createDb,
  getActivity,
  getActivityByPublicCode,
  getActivitySummary,
  insertActivity,
  migrate,
  StaleRevisionError,
  updateActivity,
} from "../src/index.js";
import type { Database } from "../src/index.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_test_${Date.now()}_${process.pid}`;

let db: Kysely<Database>;
let admin: Client;

describe.skipIf(!connectionString)("activity repository on PostgreSQL", () => {
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

  it("stores a short public code that is separate from the activity id", async () => {
    const draft = createActivity({ id: "act-public-code", title: "Public" });
    await insertActivity(db, draft, () => "K7M4-P2QX");
    const summary = await getActivitySummary(db, draft.id);
    expect(summary?.publicCode).toBe("K7M4-P2QX");
    expect(summary?.publicCode).not.toBe(draft.id);
    expect(await getActivityByPublicCode(db, "k7m4 p2qx")).toMatchObject({
      id: draft.id,
      publicCode: "K7M4-P2QX",
    });
  });

  it("retries when a generated public code is already taken", async () => {
    const first = createActivity({ id: "act-public-a", title: "A" });
    const second = createActivity({ id: "act-public-b", title: "B" });
    await insertActivity(db, first, () => "M8N5-Q3RY");
    const codes = ["M8N5-Q3RY", "P2QX-K7M4"];
    await insertActivity(db, second, () => codes.shift() ?? "P2QX-K7M4");
    expect((await getActivitySummary(db, second.id))?.publicCode).toBe("P2QX-K7M4");
    expect((await getActivitySummary(db, first.id))?.publicCode).toBe("M8N5-Q3RY");
  });

  it("persists and reads an activity", async () => {
    const draft = createActivity({
      id: "act-crud",
      title: "CRUD",
      capabilities: ["competition"],
    });
    await insertActivity(db, draft);
    expect(await getActivity(db, "act-crud")).toEqual(draft);
  });

  it("compare-and-swap on the activity revision", async () => {
    const draft = createActivity({ id: "act-cas", title: "CAS" });
    await insertActivity(db, draft);
    const active = activateActivity(draft, draft.revision);
    const saved = await updateActivity(db, active, draft.revision);
    expect(saved.status).toBe("active");
    expect(saved.revision).toBe(1);
    await expect(updateActivity(db, active, draft.revision)).rejects.toBeInstanceOf(
      StaleRevisionError,
    );
  });

  it("lets exactly one of two concurrent writers win the revision", async () => {
    const draft = createActivity({ id: "act-race", title: "Race" });
    await insertActivity(db, draft);
    const active = activateActivity(draft, draft.revision);

    const second = createDb({ connectionString: connectionString ?? "", schema });
    try {
      const results = await Promise.allSettled([
        updateActivity(db, active, 0),
        updateActivity(second, active, 0),
      ]);

      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const rejected = results.filter(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      expect(rejected).toHaveLength(1);
      expect(rejected[0]?.reason).toBeInstanceOf(StaleRevisionError);

      const final = await getActivity(db, "act-race");
      expect(final?.revision).toBe(1);
    } finally {
      await closeDb(second);
    }
  });
});
