import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

import {
  closeDb,
  createDb,
  migrate,
  readEventsSince,
} from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import {
  createEmptyCompetitionDefinition,
  createEmptyRegistrationDefinition,
  createMaterialsDefinition,
  createQuestionnaireDefinition,
  defaultCapabilityRegistry,
  type ActorContext,
} from "@artflow-plus/domain";
import type { Kysely } from "kysely";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  activateActivity,
  compileDefinition,
  createActivity,
  finalizeRoster,
  prepareCompetitionRound,
  releaseDefinitionCommand,
  reviewRegistration,
  startRegistration,
  startExecution,
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
  permissions: ["registration.review", "registration.roster.finalize", "competition.round.prepare"],
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
  const definition = {
    schemaVersion: 1 as const,
    manifest: { key: "unknown-roster", title: "Unknown roster golden" },
    capabilities: {
      competition: createEmptyCompetitionDefinition(),
      registration: createEmptyRegistrationDefinition(),
      questionnaire: createQuestionnaireDefinition("v1", []),
      materials: createMaterialsDefinition(25_000_000, []),
    },
    bindings: [],
  };
  const created = await createActivity(db, defaultCapabilityRegistry, deps(staff), {
    commandId: "golden-create-activity",
    title: "Unknown roster golden",
    capabilities: ["competition", "registration", "questionnaire", "materials"],
    initialDefinition: definition,
  });
  await activateActivity(db, deps(staff), {
    commandId: "golden-activate-activity",
    activityId: created.body.id,
    expectedRevision: created.body.revision,
  });
  return created.body.id;
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
    const compileStep = fixture.steps.find((step) => step.command === "compile_ruleset");
    expect(compileStep?.expect).toMatchObject({ outcome: "accepted", events: ["RulesetCompiled"] });
    const compiled = await compileDefinition(db, defaultCapabilityRegistry, deps(staff), {
      commandId: "golden-compile-ruleset",
      activityId,
      expectedDraftRevision: 0,
      package: {
        schemaVersion: 1,
        manifest: { key: "unknown-roster", title: "Unknown roster golden" },
        capabilities: {
          competition: createEmptyCompetitionDefinition(),
          registration: createEmptyRegistrationDefinition(),
          questionnaire: createQuestionnaireDefinition("v1", []),
          materials: createMaterialsDefinition(25_000_000, []),
        },
        bindings: [],
      },
    });
    expect(compiled.status).toBe(200);
    let events = await readEventsSince(db, { activityId, after: 0, limit: 500 });
    expect(events.some((event) => event.type === "DefinitionCompiled")).toBe(true);
    const freezeStep = fixture.steps.find((step) => step.command === "freeze_ruleset");
    expect(freezeStep?.expect).toMatchObject({ outcome: "accepted", events: ["RulesetFrozen"] });
    const released = await releaseDefinitionCommand(db, defaultCapabilityRegistry, deps(staff), {
      commandId: "golden-freeze-ruleset",
      activityId,
      expectedDraftRevision: compiled.body.draftRevision,
    });
    expect(released.status).toBe(201);
    events = await readEventsSince(db, { activityId, after: 0, limit: 500 });
    expect(events.some((event) => event.type === "DefinitionReleased")).toBe(true);
    await startExecution(db, defaultCapabilityRegistry, deps(staff), {
      commandId: "golden-start-judging",
      activityId,
      scope: "judging",
      mode: "formal",
    });
    events = await readEventsSince(db, { activityId, after: 0, limit: 500 });
    expect(events.some((event) => event.type === "ExecutionSessionStarted")).toBe(true);
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
    const finalRosterStep = fixture.steps.find((step) => step.command === "set_roster_final");
    expect(finalRosterStep?.expect).toMatchObject({ outcome: "accepted", events: ["RosterFinalized"] });

    const accepted = await prepareCompetitionRound(db, deps(staff), {
      commandId: "golden-prepare-after-roster",
      activityId,
      roundKey: "round-1",
      scope: "judging",
    });
    expect(accepted.body).toMatchObject({ roundKey: "round-1", participantCount: 15 });
    const acceptedStep = fixture.steps.find(
      (step) => step.command === "prepare_round" && step.expect.outcome === "accepted",
    );
    expect(acceptedStep?.expect).toMatchObject({ outcome: "accepted", events: ["RoundPrepared"] });
    events = await readEventsSince(db, { activityId, after: before.at(-1)?.sequence ?? 0, limit: 500 });
    expect(events.some((event) => event.type === "CompetitionRoundPrepared")).toBe(true);
  });
});
