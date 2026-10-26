import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  closeDb,
  createDb,
  getCurrentRankingSnapshot,
  getRelease,
  getRoundByKey,
  migrate,
} from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import type { ActorContext } from "@artflow-plus/domain";
import { buildPodiumCandidate, createLocalArchiveStorage } from "@artflow-plus/runtime";
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
const schema = `artflow_activity_shapes_${Date.now()}_${process.pid}`;

let db: Kysely<Database>;
let admin: Client;
let opsApp: FastifyInstance;
let participantApp: FastifyInstance;
let root: string;

const ops: ActorContext = {
  actorId: "shape-ops",
  actorType: "user",
  roles: ["admin"],
  permissions: [
    "studio.manage",
    "competition.manage",
    "competition.round.prepare",
    "competition.score.write",
    "registration.manage",
    "registration.review",
    "registration.roster.finalize",
    "materials.manage",
    "materials.review",
    "materials.read",
    "archive.manage",
    "result.manage",
    "voting.manage",
    "judge.manage",
  ],
};
const participant: ActorContext = {
  actorId: "shape-participant",
  actorType: "user",
  roles: ["participant"],
  permissions: [],
};

function headers(): Record<string, string> {
  return {
    "content-type": "application/json",
    "idempotency-key": `cmd-${randomUUID()}`,
  };
}

async function getJson(app: FastifyInstance, url: string): Promise<Record<string, unknown>> {
  const response = await app.inject({ method: "GET", url });
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as Record<string, unknown>;
}

async function postJson(
  app: FastifyInstance,
  url: string,
  payload: Record<string, unknown>,
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const response = await app.inject({ method: "POST", url, headers: headers(), payload });
  return { statusCode: response.statusCode, body: response.json() as Record<string, unknown> };
}

async function patchJson(
  app: FastifyInstance,
  url: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await app.inject({ method: "PATCH", url, headers: headers(), payload });
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as Record<string, unknown>;
}

interface Shape {
  readonly activityId: string;
  readonly publicCode: string;
  readonly definition: Record<string, unknown>;
}

async function createShape(packId: string, title: string, answers: Record<string, boolean> = {}): Promise<Shape> {
  const preview = await postJson(opsApp, `/api/packs/${packId}/instantiate`, { title, answers });
  expect(preview.statusCode, JSON.stringify(preview.body)).toBe(200);
  const created = await postJson(opsApp, "/api/activities", { title, packId, answers });
  expect(created.statusCode, JSON.stringify(created.body)).toBe(201);
  const activity = created.body as unknown as { id: string; revision: number };
  const activated = await postJson(opsApp, `/api/activities/${activity.id}/activate`, {
    expectedRevision: activity.revision,
  });
  expect(activated.statusCode, JSON.stringify(activated.body)).toBe(200);
  const compiled = await postJson(opsApp, `/api/activities/${activity.id}/definitions/compile`, {
    package: preview.body.definition,
  });
  expect(compiled.statusCode, JSON.stringify(compiled.body)).toBe(200);
  const draftRevision = (compiled.body as unknown as { draftRevision: number }).draftRevision;
  const released = await postJson(opsApp, `/api/activities/${activity.id}/definitions/release`, {
    expectedDraftRevision: draftRevision,
  });
  expect(released.statusCode, JSON.stringify(released.body)).toBe(201);
  const studio = await getJson(opsApp, `/api/activities/${activity.id}/studio`);
  return {
    activityId: activity.id,
    publicCode: (studio.activity as unknown as { publicCode: string }).publicCode,
    definition: preview.body.definition as Record<string, unknown>,
  };
}

async function registerAndApprove(shape: Shape, answers: Record<string, string>, file?: {
  readonly questionKey: string;
  readonly originalName: string;
  readonly contentType: string;
  readonly byteLength: number;
}): Promise<{ registrationId: string; participantId: string }> {
  const started = await postJson(participantApp, `/api/activities/${shape.activityId}/registrations`, {});
  expect(started.statusCode, JSON.stringify(started.body)).toBe(201);
  const registration = started.body as unknown as { id: string; revision: number; participantId: string };
  let revision = registration.revision;
  for (const [questionKey, value] of Object.entries(answers)) {
    const saved = await patchJson(participantApp,
      `/api/activities/${shape.activityId}/registrations/${registration.id}/answers`,
      { expectedRevision: revision, questionKey, value });
    revision = (saved as unknown as { revision: number }).revision;
  }
  if (file !== undefined) {
    const material = await postJson(participantApp,
      `/api/activities/${shape.activityId}/registrations/${registration.id}/materials`, file);
    expect(material.statusCode, JSON.stringify(material.body)).toBe(201);
  }
  const submitted = await postJson(participantApp,
    `/api/activities/${shape.activityId}/registrations/${registration.id}/submit`,
    { expectedRevision: revision });
  expect(submitted.statusCode, JSON.stringify(submitted.body)).toBe(200);
  const submittedRevision = (submitted.body as unknown as { revision: number }).revision;
  const reviewed = await postJson(opsApp,
    `/api/activities/${shape.activityId}/registrations/${registration.id}/review`,
    { expectedRevision: submittedRevision, status: "approved", note: "ok" });
  expect(reviewed.statusCode, JSON.stringify(reviewed.body)).toBe(200);
  return { registrationId: registration.id, participantId: registration.participantId };
}

async function finalizeRoster(activityId: string): Promise<void> {
  const response = await postJson(opsApp, `/api/activities/${activityId}/roster/finalize`, { expectedRevision: 0 });
  expect(response.statusCode, JSON.stringify(response.body)).toBe(200);
}

async function startSession(activityId: string, scope: string): Promise<void> {
  const response = await postJson(opsApp, `/api/activities/${activityId}/executions`, { scope, mode: "formal" });
  expect(response.statusCode, JSON.stringify(response.body)).toBe(201);
}

interface LiveRound {
  readonly round: { readonly id: string; readonly revision: number };
  readonly panel: { readonly id: string };
  readonly seats: readonly { readonly id: string; readonly judgeId: string }[];
  readonly performances: readonly { readonly id: string; readonly contextVersion: number }[];
}

async function liveRound(activityId: string): Promise<LiveRound> {
  const state = await getJson(opsApp, `/api/activities/${activityId}/live`);
  return (state.rounds as unknown as LiveRound[])[0] as LiveRound;
}

async function runCompetitionRound(
  shape: Shape,
  roundKey: string,
  criteria: Record<string, number>,
): Promise<{ roundId: string; contestantId: string }> {
  const prepared = await postJson(opsApp, `/api/activities/${shape.activityId}/competition/rounds`, {
    roundKey,
    scope: "judging",
  });
  expect(prepared.statusCode, JSON.stringify(prepared.body)).toBe(201);
  const panel = await postJson(opsApp,
    `/api/activities/${shape.activityId}/competition/rounds/${roundKey}/panel`,
    { scope: "judging", judges: [
      { judgeId: "judge-1", seatKey: "seat-1" },
      { judgeId: "judge-2", seatKey: "seat-2" },
      { judgeId: "judge-3", seatKey: "seat-3" },
    ] });
  expect(panel.statusCode, JSON.stringify(panel.body)).toBe(201);

  const participantId = participant.actorId;
  const performanceId = randomUUID();
  const opened = await postJson(opsApp,
    `/api/activities/${shape.activityId}/competition/rounds/${roundKey}/performances/${performanceId}/open`,
    { scope: "judging", contestantId: participantId, sequence: 1 });
  expect(opened.statusCode, JSON.stringify(opened.body)).toBe(201);

  const live = await liveRound(shape.activityId);
  const performance = live.performances[0];
  expect(performance).toBeDefined();
  const seats = live.seats.slice(0, 2);
  for (const seat of seats) {
    const scored = await postJson(opsApp,
      `/api/activities/${shape.activityId}/competition/rounds/${roundKey}/scores`,
      {
        scope: "judging",
        source: "staff_rapid",
        performanceId: performance?.id,
        panelSnapshotId: live.panel.id,
        seatId: seat.id,
        contextVersion: performance?.contextVersion,
        criteria,
        notes: "",
      });
    expect(scored.statusCode, JSON.stringify(scored.body)).toBe(201);
  }
  const locked = await postJson(opsApp,
    `/api/activities/${shape.activityId}/competition/rounds/${roundKey}/performances/${performance?.id}/lock`,
    { scope: "judging" });
  expect(locked.statusCode, JSON.stringify(locked.body)).toBe(200);
  const currentRound = (await liveRound(shape.activityId)).round;
  const roundLocked = await postJson(opsApp,
    `/api/activities/${shape.activityId}/competition/rounds/${roundKey}/lock`,
    { scope: "judging", expectedRevision: currentRound.revision });
  expect(roundLocked.statusCode, JSON.stringify(roundLocked.body)).toBe(200);
  const resolved = await postJson(opsApp,
    `/api/activities/${shape.activityId}/competition/rounds/${roundKey}/resolve`,
    { scope: "judging" });
  expect(resolved.statusCode, JSON.stringify(resolved.body)).toBe(201);
  return { roundId: currentRound.id, contestantId: participantId };
}

describe.skipIf(!connectionString)("three activity shapes", () => {
  beforeAll(async () => {
    if (!connectionString) return;
    admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = createDb({ connectionString, schema });
    await migrate(db);
    root = await mkdtemp(join(tmpdir(), "artflow-shapes-"));
    const deps: RuntimeDeps = {
      now: () => new Date().toISOString(),
      newEventId: () => randomUUID(),
      archiveStorage: createLocalArchiveStorage(root),
    };
    opsApp = await buildApp({ db, deps, actor: ops });
    participantApp = await buildApp({ db, deps, actor: participant });
    await Promise.all([opsApp.ready(), participantApp.ready()]);
  });

  afterAll(async () => {
    if (!connectionString) return;
    await Promise.all([opsApp.close(), participantApp.close()]);
    await closeDb(db);
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
    await rm(root, { recursive: true, force: true });
  });

  it("runs a judged singer competition from the guided pack", async () => {
    const shape = await createShape("singer-competition", "Shape Singer");
    await registerAndApprove(shape, { name: "Alice", student_id: "20250001", song: "夜空中最亮的星" });
    await finalizeRoster(shape.activityId);
    await startSession(shape.activityId, "judging");
    await runCompetitionRound(shape, "final", { 演唱技巧: 90, 舞台表现: 92, 情感表达: 91 });
    const live = await getJson(opsApp, `/api/activities/${shape.activityId}/live`);
    expect((live.rounds as unknown as LiveRound[])[0]?.round).toMatchObject({ state: "locked" });
  });

  it("runs a stage show through registration, review, roster, and archive", async () => {
    const shape = await createShape("stage-show", "Shape Stage");
    await registerAndApprove(
      shape,
      { name: "导演组", program: "毕业短片" },
      { questionKey: "work_file", originalName: "film.mp4", contentType: "video/mp4", byteLength: 1024 },
    );
    await finalizeRoster(shape.activityId);
    const activity = await getJson(opsApp, `/api/activities/${shape.activityId}`);
    const closed = await postJson(opsApp, `/api/activities/${shape.activityId}/close`, {
      expectedRevision: (activity as unknown as { revision: number }).revision,
    });
    expect(closed.statusCode, JSON.stringify(closed.body)).toBe(200);
    const archived = await postJson(opsApp, `/api/activities/${shape.activityId}/archive`, {
      expectedRevision: (closed.body as unknown as { revision: number }).revision,
      note: "彩排归档",
    });
    expect(archived.statusCode, JSON.stringify(archived.body)).toBe(201);
    const rounds = await db.selectFrom("competition_round").select("id")
      .where("activity_id", "=", shape.activityId).execute();
    expect(rounds).toEqual([]);
    const releases = await db.selectFrom("result_release").select("id")
      .where("activity_id", "=", shape.activityId).execute();
    expect(releases).toEqual([]);
  });

  it("runs a review-awards activity and publishes its snapshot", async () => {
    const shape = await createShape("review-awards", "Shape Review");
    await registerAndApprove(
      shape,
      { name: "作者", work_title: "光的形状" },
      { questionKey: "work_file", originalName: "work.mp4", contentType: "video/mp4", byteLength: 2048 },
    );
    await finalizeRoster(shape.activityId);
    await startSession(shape.activityId, "judging");
    const round = await runCompetitionRound(shape, "review", { 主题: 88, 完成度: 90, 表现力: 89 });

    const release = await getRelease(db, shape.activityId, 1);
    expect(release).not.toBeNull();
    const requiredRoundIds = [round.roundId];
    const roundRow = await getRoundByKey(db, shape.activityId, "review");
    expect(roundRow).not.toBeNull();
    const ranking = await getCurrentRankingSnapshot(db, roundRow!.id, "formal");
    expect(ranking).not.toBeNull();
    const candidate = buildPodiumCandidate({
      requiredRoundIds,
      rounds: [{
        roundId: round.roundId,
        sourceScoreVersion: roundRow!.scoreVersion,
        locked: true,
        ranking: {
          status: ranking!.status,
          rows: ranking!.rows,
          tieGroups: ranking!.tieGroups,
          inputFingerprint: ranking!.inputFingerprint,
        } as Parameters<typeof buildPodiumCandidate>[0]["rounds"][number]["ranking"],
      }],
    });

    await startSession(shape.activityId, "publishing");
    const recomputed = await postJson(opsApp, `/api/activities/${shape.activityId}/competition/podium/recompute`, {
      scope: "publishing",
      roundIds: requiredRoundIds,
      expectedInputFingerprint: candidate.inputFingerprint,
    });
    expect(recomputed.statusCode, JSON.stringify(recomputed.body)).toBe(201);
    const publishedCandidate = recomputed.body as unknown as {
      revision: number;
      inputFingerprint: string;
      placements: { contestantId: string }[];
    };
    const confirmed = await postJson(opsApp,
      `/api/activities/${shape.activityId}/publishing/stage-results/final_podium/confirm`,
      {
        scope: "publishing",
        expectedSourceRevision: publishedCandidate.revision,
        expectedInputFingerprint: publishedCandidate.inputFingerprint,
        awards: [{ award: "冠军", contestantId: participant.actorId }],
        note: "作品赛核定",
      });
    expect(confirmed.statusCode, JSON.stringify(confirmed.body)).toBe(201);
    const stageResult = confirmed.body as unknown as { candidateRevision: number };
    const released = await postJson(opsApp, `/api/activities/${shape.activityId}/publishing/releases`, {
      stageKey: "final_podium",
      scope: "publishing",
      expectedCandidateRevision: stageResult.candidateRevision,
      note: "正式发布",
    });
    expect(released.statusCode, JSON.stringify(released.body)).toBe(201);
    const publicResults = await getJson(opsApp, `/api/public/results/${shape.publicCode}`);
    expect(publicResults.results).toHaveLength(1);
    expect((publicResults.results as unknown as { decisions: unknown[] }[])[0]?.decisions)
      .toMatchObject([{ rank: 1, contestantId: participant.actorId }]);
  });
});
