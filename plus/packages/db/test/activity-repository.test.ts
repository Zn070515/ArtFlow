import { activateActivity, createActivity } from "@artflow-plus/domain";
import type { Kysely } from "kysely";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  closeDb,
  createDb,
  getActivity,
  insertActivity,
  migrate,
  saveActivityWithRevision,
  StaleRevisionError,
} from "../src/index.js";
import type { Database } from "../src/index.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_test_${Date.now()}_${process.pid}`;

let db: Kysely<Database>;
let admin: Client;

async function count(table: "command_receipt" | "outbox"): Promise<number> {
  const row = await db
    .selectFrom(table)
    .select((expression) => expression.fn.countAll<string>().as("count"))
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

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

  it("persists an activity and records the receipt and outbox event", async () => {
    const draft = createActivity({ id: "act-crud", title: "CRUD", capabilities: ["competition"] });
    await insertActivity(db, draft);
    expect(await getActivity(db, "act-crud")).toEqual(draft);

    const active = activateActivity(draft, draft.revision);
    const saved = await saveActivityWithRevision(db, active, {
      expectedRevision: draft.revision,
      commandId: "cmd-activate-crud",
      eventType: "ActivityActivated",
    });
    expect(saved.status).toBe("active");
    expect(saved.revision).toBe(1);
    expect(await count("command_receipt")).toBe(1);
    expect(await count("outbox")).toBe(1);
  });

  it("refuses a stale revision without writing a receipt or event", async () => {
    const draft = createActivity({ id: "act-stale", title: "Stale" });
    await insertActivity(db, draft);
    const active = activateActivity(draft, draft.revision);
    await saveActivityWithRevision(db, active, {
      expectedRevision: 0,
      commandId: "cmd-activate-stale",
      eventType: "ActivityActivated",
    });

    await expect(
      saveActivityWithRevision(db, { ...active, revision: 2 }, {
        expectedRevision: 0,
        commandId: "cmd-activate-stale-2",
        eventType: "ActivityActivated",
      }),
    ).rejects.toBeInstanceOf(StaleRevisionError);
    expect(await count("command_receipt")).toBe(2);
    expect(await count("outbox")).toBe(2);
  });

  it("lets exactly one of two concurrent writers win the revision", async () => {
    const draft = createActivity({ id: "act-race", title: "Race" });
    await insertActivity(db, draft);
    const active = activateActivity(draft, draft.revision);

    const second = createDb({ connectionString: connectionString ?? "", schema });
    try {
      const results = await Promise.allSettled([
        saveActivityWithRevision(db, active, {
          expectedRevision: 0,
          commandId: "cmd-race-a",
          eventType: "ActivityActivated",
        }),
        saveActivityWithRevision(second, active, {
          expectedRevision: 0,
          commandId: "cmd-race-b",
          eventType: "ActivityActivated",
        }),
      ]);

      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const rejected = results.filter(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      expect(rejected).toHaveLength(1);
      expect(rejected[0]?.reason).toBeInstanceOf(StaleRevisionError);

      const final = await getActivity(db, "act-race");
      expect(final?.revision).toBe(1);
      expect(await count("command_receipt")).toBe(3);
      expect(await count("outbox")).toBe(3);
    } finally {
      await closeDb(second);
    }
  });
});
