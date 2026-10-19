import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  closeDb,
  createDb,
  insertJudgeEntrySeat,
  insertRelease,
  insertSession,
  getLiveState,
  migrate,
  readEventsSince,
} from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import type { ActorContext, ExecutionSession } from "@artflow-plus/domain";
import { Client } from "pg";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  capabilityCredential,
  authenticateTicketSession,
  claimJudgeSeat,
  closeJudgeEntry,
  closeVoteSession,
  getClosedVoteScores,
  issueTicket,
  openVoteSession,
  relayOutboxOnce,
  rebuildVotingLiveProjection,
  reissueJudgeCapability,
  redeemTicketCredential,
  submitJudgeScore,
  submitBallot,
} from "../src/index.js";
import type { RuntimeDeps } from "../src/index.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
const schema = `artflow_m6_voting_ticketing_${Date.now()}_${process.pid}`;
const secret = "m6-test-credential-secret";
const capabilityFixture = JSON.parse(
  readFileSync(resolve(process.cwd(), "../../../", "tests/golden/capability-reissue-close.json"), "utf8"),
) as {
  readonly id: string;
  readonly invariants: readonly string[];
  readonly steps: readonly { readonly input: Record<string, unknown>; readonly expect: { readonly outcome: string; readonly reason?: string; readonly events?: readonly string[] } }[];
};

let db: Kysely<Database>;
let admin: Client;
let tick = 0;

const staff: ActorContext = {
  actorId: "m6-staff",
  actorType: "user",
  roles: ["staff"],
  permissions: ["voting.manage", "ticket.manage", "judge.manage"],
};
const judgeA: ActorContext = {
  actorId: "judge:teacher-a",
  actorType: "user",
  roles: ["judge"],
  permissions: [],
};
const judgeB: ActorContext = {
  actorId: "judge:teacher-b",
  actorType: "user",
  roles: ["judge"],
  permissions: [],
};

function deps(actor: ActorContext): RuntimeDeps {
  return {
    actor,
    credentialSecret: secret,
    now: () => new Date(Date.UTC(2026, 9, 19, 18, 0, tick++)).toISOString(),
    newEventId: () => `m6-${randomUUID()}`,
  };
}

async function seedActivity(activityId = `activity-${randomUUID()}`, includeJudging = false): Promise<string> {
  const competition = {
    ok: true as const,
    capabilityKey: "competition",
    contentHash: "competition",
    artifact: {
      version: 1,
      schemaVersion: 1,
      rounds: [{ key: "round-1", judgeCount: 1, minimumJudges: 1, completion: "minimum_valid", advanceCount: 1, scoringMethod: "average" }],
      rubric: { criteria: [
        { key: "演唱技巧", weight: 1, maximum: 100, minimum: 0 },
        { key: "舞台表现", weight: 1, maximum: 100, minimum: 0 },
        { key: "情感表达", weight: 1, maximum: 100, minimum: 0 },
      ] },
      tiePolicy: "review",
    },
  };
  await db.insertInto("activity").values({
    id: activityId,
    public_code: activityId === "act-2026" ? "ABC123" : activityId,
    title: "M6 activity",
    status: "active",
    revision: 1,
    enabled_capabilities: JSON.stringify(includeJudging ? ["competition", "ticketing", "voting"] : ["ticketing", "voting"]),
    active_definition_version: 1,
  }).execute();
  await insertRelease(db, {
    activityId,
    version: 1,
    contentHash: "m6-release",
    capabilities: {
      ticketing: { ok: true, capabilityKey: "ticketing", contentHash: "ticketing", artifact: { schemaVersion: 1 } },
      voting: {
        ok: true,
        capabilityKey: "voting",
        contentHash: "voting",
        artifact: {
          version: 1,
          schemaVersion: 1,
          purpose: "score_component",
          selectionType: "single",
          maxSelections: 1,
          requiresTicket: true,
          allowBrowserIdentity: false,
          scoringRule: { kind: "ballot_share_percent", scale: 100, decimals: 2 },
        },
      },
      ...(includeJudging ? { competition } : {}),
    },
    executionPolicy: { declaredScopes: includeJudging ? ["judging", "voting"] : ["voting"], conflicts: {}, runtimeContractVersion: 1 },
    capabilityVersions: includeJudging ? { competition: "1", ticketing: "1", voting: "1" } : { ticketing: "1", voting: "1" },
    bindings: [],
    releasedAt: "2026-10-19T17:00:00Z",
    sourceDraftRevision: 1,
  });
  const session: ExecutionSession = {
    id: `execution-${activityId}`,
    activityId,
    definitionVersion: 1,
    contentHash: "m6-release",
    scope: "voting",
    mode: "formal",
    status: "running",
    revision: 0,
  };
  await insertSession(db, session, "2026-10-19T17:00:00Z");
  return activityId;
}

async function seedJudgeScoreContext(activityId: string) {
  const roundId = `m6-round-${activityId}`;
  const panelId = `m6-panel-${activityId}`;
  const seatId = `m6-seat-${activityId}`;
  const performanceId = `m6-performance-${activityId}`;
  await insertSession(db, {
    id: `m6-judging-session-${activityId}`,
    activityId,
    definitionVersion: 1,
    contentHash: "m6-release",
    scope: "judging",
    mode: "formal",
    status: "running",
    revision: 0,
  }, "2026-10-19T17:00:00Z");
  await db.insertInto("competition_round").values({
    id: roundId,
    activity_id: activityId,
    round_key: "round-1",
    release_version: 1,
    state: "scoring",
    revision: 0,
    score_version: 0,
    minimum_judges: 1,
    judge_count: 1,
    completion_mode: "minimum_valid",
    scoring_method: "average",
    advance_count: 1,
    current_panel_id: panelId,
    locked_at: null,
  }).execute();
  await db.insertInto("panel_snapshot").values({
    id: panelId,
    activity_id: activityId,
    round_id: roundId,
    version: 1,
    state: "active",
    expected_judges: 1,
    minimum_judges: 1,
    roster_digest: "a".repeat(64),
    context_version: 1,
    current: true,
  }).execute();
  await db.insertInto("panel_member").values({ panel_id: panelId, judge_id: judgeA.actorId, seat_key: "seat-judge-a" }).execute();
  await db.insertInto("judge_seat").values({
    id: seatId,
    panel_id: panelId,
    judge_id: judgeA.actorId,
    state: "assigned",
    revision: 0,
  }).execute();
  await db.insertInto("performance").values({
    id: performanceId,
    activity_id: activityId,
    round_id: roundId,
    contestant_id: "singer-a",
    sequence: 1,
    state: "open",
    context_version: 1,
  }).execute();
  await db.insertInto("performance_score_state").values({
    performance_id: performanceId,
    state: "open",
    context_version: 1,
    revision: 0,
    opened_at: "2026-10-19T17:00:00Z",
    locked_at: null,
  }).execute();
  return { roundId, panelId, seatId, performanceId };
}

describe.skipIf(!connectionString)("M6 voting and ticketing runtime", () => {
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

  it("keeps ticket-backed ballot uniqueness at the database/runtime boundary", async () => {
    const activityId = await seedActivity();
    const ticket = await issueTicket(db, deps(staff), { commandId: "m6-ticket-1", activityId });
    expect(ticket.body.credential).toEqual(expect.any(String));
    const redeemable = await issueTicket(db, deps(staff), { commandId: "m6-ticket-redeem", activityId });
    const redeemed = await redeemTicketCredential(db, deps(judgeA), { commandId: "m6-redeem", credential: redeemable.body.credential ?? "" });
    expect(redeemed.body.accessToken).toEqual(expect.any(String));
    const receipt = await db.selectFrom("command_receipt").select("result").where("command_id", "=", "m6-redeem").executeTakeFirstOrThrow();
    expect(JSON.stringify(receipt.result)).not.toContain(redeemed.body.accessToken ?? "");
    await expect(authenticateTicketSession(db, redeemed.body.accessToken ?? "")).resolves.toMatchObject({ ticketId: redeemable.body.ticket.id });
    await expect(redeemTicketCredential(db, deps(judgeA), {
      commandId: "m6-redeem-replay",
      credential: redeemable.body.credential ?? "",
    })).rejects.toMatchObject({ code: "TICKET_REPLAYED" });
    const opened = await openVoteSession(db, deps(staff), {
      commandId: "m6-vote-open-1",
      activityId,
      sessionId: "vote-1",
      scope: "voting",
      candidateIds: ["singer-a", "singer-b"],
    });
    const option = opened.body.options[0];
    expect(option).toBeDefined();
    const submitted = await submitBallot(db, deps(judgeA), {
      commandId: "m6-ballot-1",
      activityId,
      sessionId: "vote-1",
      scope: "voting",
      optionIds: [option?.id ?? ""],
      identity: { type: "ticket", credential: ticket.body.credential ?? "" },
    });
    expect(submitted.body.ballot.identityType).toBe("ticket");
    await expect(submitBallot(db, deps(judgeA), {
      commandId: "m6-ballot-2",
      activityId,
      sessionId: "vote-1",
      scope: "voting",
      optionIds: [option?.id ?? ""],
      identity: { type: "ticket", credential: ticket.body.credential ?? "" },
    })).rejects.toMatchObject({ code: "DUPLICATE_BALLOT" });
    const closed = await closeVoteSession(db, deps(staff), {
      commandId: "m6-vote-close-1",
      activityId,
      sessionId: "vote-1",
      scope: "voting",
      expectedRevision: 0,
    });
    expect(closed.body.status).toBe("closed");
    await expect(submitBallot(db, deps(judgeA), {
      commandId: "m6-ballot-3",
      activityId,
      sessionId: "vote-1",
      scope: "voting",
      optionIds: [option?.id ?? ""],
      identity: { type: "ticket", credential: ticket.body.credential ?? "" },
    })).rejects.toMatchObject({ code: "VOTE_SESSION_CLOSED" });
    await expect(getClosedVoteScores(db, "vote-1")).resolves.toMatchObject({
      totalBallots: 1,
      rawCounts: { [option?.id ?? ""]: 1, [opened.body.options[1]?.id ?? ""]: 0 },
      scoreInputs: { [option?.id ?? ""]: 100, [opened.body.options[1]?.id ?? ""]: 0 },
    });
    await relayOutboxOnce(db);
    await expect(getLiveState(db, activityId, "vote_session", "vote-1")).resolves.toMatchObject({
      status: "running",
      state: { status: "closed", counts: { [option?.id ?? ""]: 1 }, authoritative: false },
    });
    const rebuilt = await rebuildVotingLiveProjection(db, activityId, "vote-1", "formal");
    expect(rebuilt.state).toMatchObject({ status: "closed", counts: { [option?.id ?? ""]: 1 }, authoritative: false });
  });

  it("rejects a ticket from another activity without accepting a cross-activity ballot", async () => {
    const first = await seedActivity();
    const second = await seedActivity();
    const ticket = await issueTicket(db, deps(staff), { commandId: "m6-cross-ticket", activityId: second });
    const opened = await openVoteSession(db, deps(staff), {
      commandId: "m6-cross-open",
      activityId: first,
      sessionId: "vote-cross",
      scope: "voting",
      candidateIds: ["singer-a"],
    });
    await expect(submitBallot(db, deps(judgeA), {
      commandId: "m6-cross-submit",
      activityId: first,
      sessionId: "vote-cross",
      scope: "voting",
      optionIds: [opened.body.options[0]?.id ?? ""],
      identity: { type: "ticket", credential: ticket.body.credential ?? "" },
    })).rejects.toMatchObject({ code: "INVALID_TICKET" });
  });

  it("adapts capability-reissue-close: old claims die while existing sessions survive", async () => {
    expect(capabilityFixture.id).toBe("capability-reissue-close");
    expect(capabilityFixture.invariants).toEqual(expect.arrayContaining(["TICK-01", "TICK-02", "TICK-03", "TICK-06"]));
    const activityId = await seedActivity("act-2026", true);
    await insertJudgeEntrySeat(db, { id: "seat-1", activityId, seatKey: "seat-1", state: "available", revision: 0 });
    await insertJudgeEntrySeat(db, { id: "seat-2", activityId, seatKey: "seat-2", state: "available", revision: 0 });
    const v1 = capabilityCredential("J", "ABC123", 1, secret);
    const first = await claimJudgeSeat(db, deps(judgeA), { commandId: "m6-judge-claim-a", publicCode: "ABC123", capability: v1 });
    expect(first.body.seatKey).toBe("seat-1");
    expect(capabilityFixture.steps[0]?.expect.outcome).toBe("accepted");
    await expect(claimJudgeSeat(db, deps({ ...judgeA, actorId: "judge:unsigned" }), {
      commandId: "m6-judge-unsigned",
      publicCode: "ABC123",
      capability: String(capabilityFixture.steps[1]?.input.capability ?? ""),
    })).rejects.toMatchObject({ code: capabilityFixture.steps[1]?.expect.reason ?? "INVALID_JUDGE_ENTRY" });
    await expect(reissueJudgeCapability(db, deps(staff), { commandId: "m6-judge-reissue", activityId, reason: String(capabilityFixture.steps[2]?.input.reason ?? "") })).resolves.toMatchObject({ body: { version: 2, capability: expect.any(String) } });
    expect(capabilityFixture.steps[2]?.expect.events).toContain("JudgeCapabilityReissued");
    await expect(claimJudgeSeat(db, deps(judgeB), { commandId: "m6-judge-old", publicCode: "ABC123", capability: v1 })).rejects.toMatchObject({ code: capabilityFixture.steps[3]?.expect.reason ?? "INVALID_JUDGE_ENTRY" });
    const v2 = capabilityCredential("J", "ABC123", 2, secret);
    const second = await claimJudgeSeat(db, deps(judgeB), { commandId: "m6-judge-claim-b", publicCode: "ABC123", capability: v2 });
    expect(second.body.seatKey).toBe("seat-2");
    await expect(closeJudgeEntry(db, deps(staff), { commandId: "m6-judge-close", activityId, reason: String(capabilityFixture.steps[5]?.input.reason ?? "") })).resolves.toMatchObject({ body: { open: false } });
    expect(capabilityFixture.steps[5]?.expect.events).toContain("JudgeEntryClosed");
    const sessionCount = await db.selectFrom("judge_session").select(({ fn }) => fn.countAll<number>().as("count")).where("activity_id", "=", activityId).executeTakeFirstOrThrow();
    expect(Number(sessionCount.count)).toBe(2);
    await expect(claimJudgeSeat(db, deps({ ...judgeB, actorId: "judge:teacher-c" }), { commandId: "m6-judge-claim-c", publicCode: "ABC123", capability: v2 })).rejects.toMatchObject({ code: capabilityFixture.steps[6]?.expect.reason ?? "JUDGE_ENTRY_CLOSED" });
    const events = await readEventsSince(db, { activityId, after: 0, limit: 100 });
    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining(["JudgeSeatClaimed", "JudgeCapabilityReissued", "JudgeEntryClosed"]));

    const scoreContext = await seedJudgeScoreContext(activityId);
    const scoreStep = capabilityFixture.steps[7];
    if (scoreStep === undefined) throw new Error("Golden capability fixture is missing the post-close score step.");
    const score = Number(scoreStep.input.score);
    const scored = await submitJudgeScore(db, deps(judgeA), {
      commandId: String(scoreStep.input.command_id),
      activityId,
      roundId: scoreContext.roundId,
      performanceId: scoreContext.performanceId,
      panelSnapshotId: scoreContext.panelId,
      seatId: scoreContext.seatId,
      contextVersion: Number(scoreStep.input.context_version),
      criteria: { "演唱技巧": score, "舞台表现": 0, "情感表达": 0 },
      notes: "",
      scope: "judging",
    });
    expect(scoreStep.expect.outcome).toBe("accepted");
    expect(scored.body.total).toBe(score);
    expect((await readEventsSince(db, { activityId, after: 0, limit: 500 })).map((event) => event.type)).toContain("ScoreFactRecorded");
  });
});
