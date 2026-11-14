import { randomUUID } from "node:crypto";

import { closeDb, createDb, migrate } from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import type { ActorContext } from "@artflow-plus/domain";
import { Client } from "pg";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  acknowledgeIncident,
  getIncidents,
  openIncident,
  reopenIncident,
  resolveIncident,
} from "../src/index.js";
import type { RuntimeDeps } from "../src/index.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_incident_${Date.now()}_${process.pid}`;
let db: Kysely<Database>;
let admin: Client;

const staff: ActorContext = {
  actorId: "incident-staff",
  actorType: "user",
  roles: ["staff"],
  permissions: ["incident.manage"],
};
const outsider: ActorContext = {
  actorId: "incident-outsider",
  actorType: "user",
  roles: ["participant"],
  permissions: [],
};
let tick = 0;
function deps(actor: ActorContext): RuntimeDeps {
  return {
    actor,
    now: () => new Date(Date.UTC(2026, 10, 14, 12, 0, tick++)).toISOString(),
    newEventId: () => `incident-${randomUUID()}`,
  };
}

async function seedActivity(): Promise<string> {
  const activityId = `activity-${randomUUID()}`;
  await db.insertInto("activity").values({
    id: activityId,
    public_code: `INC-${activityId.slice(-8)}`,
    title: "毕业晚会",
    status: "active",
    revision: 1,
    enabled_capabilities: JSON.stringify(["incident"]),
    active_definition_version: 1,
  }).execute();
  return activityId;
}

describe.skipIf(!connectionString)("incident service", () => {
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

  it("walks open -> acknowledged -> resolved -> reopened with OCC", async () => {
    const activityId = await seedActivity();
    const opened = await openIncident(db, deps(staff), {
      commandId: randomUUID(),
      activityId,
      mode: "formal",
      severity: "high",
      category: "stage",
      title: "话筒没有声音",
      location: "舞台左侧",
    });
    expect(opened.body).toMatchObject({ status: "open", revision: 0 });

    const acknowledged = await acknowledgeIncident(db, deps(staff), {
      commandId: randomUUID(),
      activityId,
      incidentId: opened.body.id,
      expectedRevision: 0,
    });
    expect(acknowledged.body).toMatchObject({
      status: "acknowledged",
      revision: 1,
      assigneeId: "incident-staff",
    });

    const resolved = await resolveIncident(db, deps(staff), {
      commandId: randomUUID(),
      activityId,
      incidentId: opened.body.id,
      expectedRevision: 1,
      resolution: "更换备用话筒",
    });
    expect(resolved.body).toMatchObject({ status: "resolved", revision: 2 });

    const reopened = await reopenIncident(db, deps(staff), {
      commandId: randomUUID(),
      activityId,
      incidentId: opened.body.id,
      expectedRevision: 2,
      reason: "同一话筒再次无声",
    });
    expect(reopened.body).toMatchObject({ status: "open", revision: 3, resolution: "" });

    expect(await getIncidents(db, activityId)).toHaveLength(1);
  });

  it("rejects stale revisions and illegal transitions", async () => {
    const activityId = await seedActivity();
    const opened = await openIncident(db, deps(staff), {
      commandId: randomUUID(),
      activityId,
      mode: "rehearsal",
      severity: "low",
      category: "technical",
      title: "投影闪烁",
    });
    await expect(
      acknowledgeIncident(db, deps(staff), {
        commandId: randomUUID(),
        activityId,
        incidentId: opened.body.id,
        expectedRevision: 99,
      }),
    ).rejects.toMatchObject({ code: "STALE_REVISION" });

    await resolveIncident(db, deps(staff), {
      commandId: randomUUID(),
      activityId,
      incidentId: opened.body.id,
      expectedRevision: 0,
      resolution: "重启投影",
    });
    await expect(
      resolveIncident(db, deps(staff), {
        commandId: randomUUID(),
        activityId,
        incidentId: opened.body.id,
        expectedRevision: 1,
        resolution: "再次解决",
      }),
    ).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
  });

  it("requires incident.manage and a resolution when resolving", async () => {
    const activityId = await seedActivity();
    await expect(
      openIncident(db, deps(outsider), {
        commandId: randomUUID(),
        activityId,
        mode: "formal",
        severity: "low",
        category: "other",
        title: "测试",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const opened = await openIncident(db, deps(staff), {
      commandId: randomUUID(),
      activityId,
      mode: "formal",
      severity: "medium",
      category: "participant",
      title: "选手迟到",
    });
    await expect(
      resolveIncident(db, deps(staff), {
        commandId: randomUUID(),
        activityId,
        incidentId: opened.body.id,
        expectedRevision: 0,
        resolution: "   ",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});
