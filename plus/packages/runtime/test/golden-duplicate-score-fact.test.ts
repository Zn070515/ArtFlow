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
  createActivity,
  activateActivity,
  compileDefinition,
  finalizeRoster,
  prepareCompetitionRound,
  releaseDefinitionCommand,
  reviewRegistration,
  startExecution,
  startRegistration,
  submitRegistration,
  submitJudgeScore,
  submitProxyScore,
  editScoreFact,
  activateCompetitionPanel,
  openPerformance,
} from "../src/index.js";
import {
  createCompetitionDefinition,
  createEmptyMaterialsDefinition,
  createEmptyQuestionnaireDefinition,
  createEmptyRegistrationDefinition,
  defaultCapabilityRegistry,
} from "@artflow-plus/domain";
import type { ActorContext } from "@artflow-plus/domain";
import type { Kysely } from "kysely";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RuntimeDeps } from "../src/index.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const fixture = JSON.parse(
  readFileSync(resolve(process.cwd(), "../../../", "tests/golden/duplicate-score-fact.json"), "utf8"),
) as {
  readonly id: string;
  readonly steps: readonly {
    readonly command: string;
    readonly actor: string;
    readonly input: Record<string, unknown>;
    readonly expect: { readonly outcome: string; readonly reason?: string; readonly events?: readonly string[] };
  }[];
};
const schema = `artflow_golden_m5_score_${Date.now()}_${process.pid}`;

let db: Kysely<Database>;
let admin: Client;
let tick = 0;

const staff: ActorContext = {
  actorId: "fixture-staff",
  actorType: "user",
  roles: ["staff"],
  permissions: ["competition.manage", "competition.round.prepare", "registration.review", "registration.roster.finalize"],
};
const judge: ActorContext = {
  actorId: "judge-j1",
  actorType: "user",
  roles: ["judge"],
  permissions: [],
};

function deps(actor: ActorContext): RuntimeDeps {
  return {
    actor,
    now: () => new Date(Date.UTC(2026, 9, 19, 20, 0, tick++)).toISOString(),
    newEventId: () => `golden-score-${randomUUID()}`,
  };
}

describe.skipIf(!connectionString)("duplicate-score-fact golden", () => {
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

  it("consumes the fixture through real Plus commands", async () => {
    expect(fixture.id).toBe("duplicate-score-fact");
    const definition = {
      schemaVersion: 1 as const,
      manifest: { key: "duplicate-score-fact", title: "Duplicate score fact" },
      capabilities: {
        competition: createCompetitionDefinition(
          [
            { key: "roster", type: "roster" },
            { key: "round-1", type: "round" },
            { key: "result", type: "output" },
          ],
          [{ from: "roster", to: "round-1" }, { from: "round-1", to: "result" }],
          {
            rounds: [{ key: "round-1", judgeCount: 2, minimumJudges: 1, completion: "minimum_valid", advanceCount: 1, scoringMethod: "average" }],
            rubric: { criteria: [
              { key: "演唱技巧", weight: 1, maximum: 100, minimum: 0 },
              { key: "舞台表现", weight: 1, maximum: 100, minimum: 0 },
              { key: "情感表达", weight: 1, maximum: 100, minimum: 0 },
            ] },
            tiePolicy: "review",
          },
        ),
        registration: createEmptyRegistrationDefinition(),
        questionnaire: createEmptyQuestionnaireDefinition(),
        materials: createEmptyMaterialsDefinition(),
      },
      bindings: [],
    };
    const created = await createActivity(db, defaultCapabilityRegistry, deps(staff), {
      commandId: "golden-score-create",
      title: "Duplicate score fact",
      capabilities: ["competition", "registration", "questionnaire", "materials"],
      initialDefinition: definition,
    });
    await activateActivity(db, deps(staff), {
      commandId: "golden-score-activate",
      activityId: created.body.id,
      expectedRevision: created.body.revision,
    });
    const compiled = await compileDefinition(db, defaultCapabilityRegistry, deps(staff), {
      commandId: "golden-score-compile",
      activityId: created.body.id,
      expectedDraftRevision: 0,
      package: definition,
    });
    const released = await releaseDefinitionCommand(db, defaultCapabilityRegistry, deps(staff), {
      commandId: "golden-score-release",
      activityId: created.body.id,
      expectedDraftRevision: compiled.body.draftRevision,
    });
    await startExecution(db, defaultCapabilityRegistry, deps(staff), {
      commandId: "golden-score-session",
      activityId: created.body.id,
      scope: "judging",
      mode: "formal",
    });
    expect(released.body.version).toBe(1);

    const participant: ActorContext = {
      actorId: "singer-a",
      actorType: "user",
      roles: ["participant"],
      permissions: [],
    };
    const registration = await startRegistration(db, deps(participant), {
      commandId: "golden-score-registration",
      activityId: created.body.id,
      participantId: participant.actorId,
    });
    const submitted = await submitRegistration(db, deps(participant), {
      commandId: "golden-score-submit",
      activityId: created.body.id,
      registrationId: registration.body.id,
      expectedRevision: registration.body.revision,
    });
    await reviewRegistration(db, deps(staff), {
      commandId: "golden-score-review",
      activityId: created.body.id,
      registrationId: registration.body.id,
      expectedRevision: submitted.body.revision,
      status: "approved",
      note: "fixture",
    });
    await finalizeRoster(db, deps(staff), {
      commandId: "golden-score-roster",
      activityId: created.body.id,
      expectedRevision: 0,
    });
    const round = await prepareCompetitionRound(db, deps(staff), {
      commandId: "golden-score-round",
      activityId: created.body.id,
      roundKey: "round-1",
      scope: "judging",
    });
    const panel = await activateCompetitionPanel(db, deps(staff), {
      commandId: "golden-score-panel",
      activityId: created.body.id,
      roundId: round.body.id,
      scope: "judging",
      judges: [
        { judgeId: "judge-j1", seatKey: "seat-j1" },
        { judgeId: "judge-j2", seatKey: "seat-j2" },
      ],
    });
    const performance = await openPerformance(db, deps(staff), {
      commandId: "golden-score-performance",
      activityId: created.body.id,
      roundId: round.body.id,
      scope: "judging",
      contestantId: "singer-a",
      sequence: 1,
    });
    const seats = await db.selectFrom("judge_seat").selectAll().where("panel_id", "=", panel.body.id).orderBy("judge_id").execute();
    const seat1 = seats.find((seat) => seat.judge_id === "judge-j1");
    const seat2 = seats.find((seat) => seat.judge_id === "judge-j2");
    if (seat1 === undefined || seat2 === undefined) throw new Error("Golden panel seats were not created.");
    const scoreStep = fixture.steps.find((step) => step.command === "submit_judge_score");
    const proxyStep = fixture.steps.find((step) => step.command === "submit_proxy_score");
    const editStep = fixture.steps.find((step) => step.command === "edit_score_fact");
    const staleStep = fixture.steps.find((step) => step.command === "submit_judge_score" && step.actor.endsWith("judge-j2"));
    if (scoreStep === undefined || proxyStep === undefined || editStep === undefined || staleStep === undefined) throw new Error("Golden score steps are incomplete.");
    const criteria = scoreStep.input.criteria as Record<string, number>;
    const accepted = await submitJudgeScore(db, deps(judge), {
      commandId: String(scoreStep.input.command_id),
      activityId: created.body.id,
      roundId: round.body.id,
      performanceId: performance.body.id,
      panelSnapshotId: panel.body.id,
      seatId: seat1.id,
      contextVersion: Number(scoreStep.input.context_version),
      criteria,
      notes: "",
      scope: "judging",
    });
    expect(accepted.body).toMatchObject({ source: "direct_judge", total: 91, version: 1 });
    expect(accepted.body.key).toBe(`${round.body.id}|singer-a|judge-j1`);
    expect((await readEventsSince(db, { activityId: created.body.id, after: 0, limit: 500 })).some((event) => event.type === "ScoreFactRecorded")).toBe(true);

    const beforeDuplicate = await readEventsSince(db, { activityId: created.body.id, after: 0, limit: 500 });
    await expect(submitProxyScore(db, deps(staff), {
      commandId: String(proxyStep.input.command_id),
      activityId: created.body.id,
      roundId: round.body.id,
      performanceId: performance.body.id,
      panelSnapshotId: panel.body.id,
      seatId: seat1.id,
      contextVersion: Number(proxyStep.input.context_version),
      criteria: { ...criteria, "情感表达": 29 },
      notes: String(proxyStep.input.reason),
      sourceReference: String(proxyStep.input.source_reference),
      reason: String(proxyStep.input.reason),
      scope: "judging",
    })).rejects.toMatchObject({ code: proxyStep.expect.reason });
    expect(await readEventsSince(db, { activityId: created.body.id, after: 0, limit: 500 })).toEqual(beforeDuplicate);

    const edited = await editScoreFact(db, deps(staff), {
      commandId: String(editStep.input.command_id),
      activityId: created.body.id,
      roundId: round.body.id,
      performanceId: performance.body.id,
      panelSnapshotId: panel.body.id,
      seatId: seat1.id,
      contextVersion: Number(scoreStep.input.context_version),
      expectedVersion: Number(editStep.input.expected_version),
      criteria: editStep.input.criteria as Record<string, number>,
      reason: String(editStep.input.reason),
      scope: "judging",
    });
    expect(edited.body).toMatchObject({ version: 2, total: 93 });
    expect((await db.selectFrom("score_fact").selectAll().where("round_id", "=", round.body.id).execute())).toHaveLength(1);

    await expect(submitJudgeScore(db, deps({ ...judge, actorId: "judge-j2" }), {
      commandId: String(staleStep.input.command_id),
      activityId: created.body.id,
      roundId: round.body.id,
      performanceId: performance.body.id,
      panelSnapshotId: panel.body.id,
      seatId: seat2.id,
      contextVersion: Number(staleStep.input.context_version),
      criteria,
      notes: "",
      scope: "judging",
    })).rejects.toMatchObject({ code: staleStep.expect.reason });
  });
});
