import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

import {
  closeDb,
  createDb,
  insertRelease,
  insertSession,
  migrate,
  readEventsSince,
} from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import type { ActorContext, ExecutionSession } from "@artflow-plus/domain";
import type { Kysely } from "kysely";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  finalizeRoster,
  prepareCompetitionRound,
  reviewRegistration,
  startRegistration,
  submitRegistration,
} from "../src/index.js";
import type { RuntimeDeps } from "../src/index.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const fixture = JSON.parse(
  readFileSync(resolve(process.cwd(), "../../../", "tests/golden/unknown-roster.json"), "utf8"),
) as {
  readonly id: string;
  readonly steps: readonly {
    readonly command: string;
    readonly expect: { readonly outcome: string; readonly reason?: string };
  }[];
};
const schema = `artflow_golden_m4_${Date.now()}_${process.pid}`;

const staff: ActorContext = {
  actorId: "fixture-staff",
  actorType: "user",
  roles: ["staff"],
  permissions: ["registration.review", "registration.roster.finalize"],
};

let db: Kysely<Database>;
let admin: Client;
let tick = 0;

function deps(actor: ActorContext): RuntimeDeps {
  return {
    actor,
    now: () => new Date(Date.UTC(2026, 9, 19, 12, 0, tick++)).toISOString(),
    newEventId: () => `golden-${randomUUID()}`,
  };
}

async function seedActivity(): Promise<string> {
  const activityId = "act-2026";
  await db.insertInto("activity").values({
    id: activityId,
    title: "Unknown roster golden",
    status: "active",
    revision: 1,
    enabled_capabilities: JSON.stringify(["competition", "registration", "questionnaire", "materials"]),
    active_definition_version: 1,
  }).execute();
  await insertRelease(db, {
    activityId,
    version: 1,
    contentHash: "golden-release",
    capabilities: {
      registration: { ok: true, capabilityKey: "registration", contentHash: "registration", artifact: { schemaVersion: 1, lifecycleVersion: 1, rosterStatus: "unknown" } },
      questionnaire: { ok: true, capabilityKey: "questionnaire", contentHash: "questionnaire", artifact: { schemaVersion: 1, version: "v1", schemaHash: "questionnaire", questions: [], fileSlots: [] } },
      materials: { ok: true, capabilityKey: "materials", contentHash: "materials", artifact: { schemaVersion: 1, maxBytes: 25_000_000, allowedPurposes: [] } },
    },
    executionPolicy: { declaredScopes: ["judging"], conflicts: {}, runtimeContractVersion: 1 },
    capabilityVersions: { competition: "1", registration: "1", questionnaire: "1", materials: "1" },
    bindings: [],
    releasedAt: "2026-10-19T11:00:00Z",
    sourceDraftRevision: 1,
  });
  const session: ExecutionSession = {
    id: "golden-judging-session",
    activityId,
    definitionVersion: 1,
    contentHash: "golden-release",
    scope: "judging",
    mode: "formal",
    status: "running",
    revision: 0,
  };
  await insertSession(db, session, "2026-10-19T11:30:00Z");
  return activityId;
}

describe.skipIf(!connectionString)("unknown-roster golden", () => {
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

  it("keeps unknown distinct from zero at the execution boundary", async () => {
    expect(fixture.id).toBe("unknown-roster");
    const activityId = await seedActivity();
    const rejectedStep = fixture.steps.find(
      (step) => step.command === "prepare_round" && step.expect.outcome === "rejected",
    );
    expect(rejectedStep?.expect.reason).toBe("ROSTER_UNKNOWN");
    const before = await readEventsSince(db, { activityId, after: 0, limit: 500 });
    await expect(prepareCompetitionRound(db, deps(staff), {
      commandId: "golden-prepare-before-roster",
      activityId,
      roundKey: "round-1",
      scope: "judging",
    })).rejects.toMatchObject({ code: "ROSTER_UNKNOWN" });
    const after = await readEventsSince(db, { activityId, after: 0, limit: 500 });
    expect(after).toEqual(before);

    for (let index = 0; index < 15; index += 1) {
      const participant: ActorContext = {
        actorId: `fixture-participant-${index}`,
        actorType: "user",
        roles: ["participant"],
        permissions: [],
      };
      const started = await startRegistration(db, deps(participant), {
        commandId: `golden-start-${index}`,
        activityId,
        participantId: participant.actorId,
      });
      const submitted = await submitRegistration(db, deps(participant), {
        commandId: `golden-submit-${index}`,
        activityId,
        registrationId: started.body.id,
        expectedRevision: started.body.revision,
      });
      await reviewRegistration(db, deps(staff), {
        commandId: `golden-review-${index}`,
        activityId,
        registrationId: started.body.id,
        expectedRevision: submitted.body.revision,
        status: "approved",
        note: "fixture",
      });
    }
    const roster = await finalizeRoster(db, deps(staff), {
      commandId: "golden-roster-final",
      activityId,
      expectedRevision: 0,
    });
    expect(roster.body).toMatchObject({ status: "final", approvedCount: 15 });

    const accepted = await prepareCompetitionRound(db, deps(staff), {
      commandId: "golden-prepare-after-roster",
      activityId,
      roundKey: "round-1",
      scope: "judging",
    });
    expect(accepted.body).toMatchObject({ roundKey: "round-1", participantCount: 15 });
    const events = await readEventsSince(db, { activityId, after: before.at(-1)?.sequence ?? 0, limit: 500 });
    expect(events.some((event) => event.type === "CompetitionRoundPrepared")).toBe(true);
  });
});
