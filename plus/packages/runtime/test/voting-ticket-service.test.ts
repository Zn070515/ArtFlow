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
  readValidVoteTally,
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
  authenticateJudgeSession,
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
  revokeTicket,
  rotateTicketCredential,
  submitJudgeScore,
  submitBallot,
} from "../src/index.js";
import type { RuntimeDeps } from "../src/index.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
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
let dbA: Kysely<Database>;
let dbB: Kysely<Database>;
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

async function seedActivity(
  activityId = `activity-${randomUUID()}`,
  includeJudging = false,
  identityPolicy: "ticket" | "browser" | "anonymous" = "ticket",
): Promise<string> {
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
          version: 2,
          schemaVersion: 2,
          purpose: "score_component",
          selectionType: "single",
          maxSelections: 1,
          identityPolicy,
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

async function seedJudgeScoreContext(activityId: string, assignedSeatId = `m6-seat-${activityId}`) {
  const roundId = `m6-round-${activityId}`;
  const panelId = `m6-panel-${activityId}`;
  const seatId = assignedSeatId;
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
    dbA = createDb({ connectionString, schema });
    dbB = createDb({ connectionString, schema });
    db = dbA;
    await migrate(db);
  });

  afterAll(async () => {
    if (!connectionString) return;
    await closeDb(dbA);
    await closeDb(dbB);
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });

  it("keeps ticket-backed ballot uniqueness at the database/runtime boundary", async () => {
    const activityId = await seedActivity();
    const ticket = await issueTicket(db, deps(staff), { commandId: "m6-ticket-1", activityId });
    expect(ticket.body.credential).toEqual(expect.any(String));
    const redeemed = await redeemTicketCredential(db, deps(judgeA), { commandId: "m6-redeem", credential: ticket.body.credential ?? "" });
    expect(redeemed.body.accessToken).toEqual(expect.any(String));
    const receipt = await db.selectFrom("command_receipt").select("result").where("command_id", "=", "m6-redeem").executeTakeFirstOrThrow();
    expect(JSON.stringify(receipt.result)).not.toContain(redeemed.body.accessToken ?? "");
    await expect(authenticateTicketSession(db, redeemed.body.accessToken ?? "")).resolves.toMatchObject({ ticketId: ticket.body.ticket.id });
    await expect(redeemTicketCredential(db, deps(judgeA), {
      commandId: "m6-redeem-replay",
      credential: ticket.body.credential ?? "",
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
      identity: { type: "ticket", sessionToken: redeemed.body.accessToken ?? "" },
    });
    expect(submitted.body.ballot.identityType).toBe("ticket");
    await expect(submitBallot(db, deps(judgeA), {
      commandId: "m6-ballot-2",
      activityId,
      sessionId: "vote-1",
      scope: "voting",
      optionIds: [option?.id ?? ""],
      identity: { type: "ticket", sessionToken: redeemed.body.accessToken ?? "" },
    })).rejects.toMatchObject({ code: "DUPLICATE_BALLOT" });
    const closed = await closeVoteSession(db, deps(staff), {
      commandId: "m6-vote-close-1",
      activityId,
      sessionId: "vote-1",
      scope: "voting",
      expectedRevision: 0,
    });
    expect(closed.body.status).toBe("closed");
    await expect(readValidVoteTally(db, "vote-1")).resolves.toEqual({
      totalBallots: 1,
      countsByOption: { [option?.id ?? ""]: 1, [opened.body.options[1]?.id ?? ""]: 0 },
    });
    await expect(submitBallot(db, deps(judgeA), {
      commandId: "m6-ballot-3",
      activityId,
      sessionId: "vote-1",
      scope: "voting",
      optionIds: [option?.id ?? ""],
      identity: { type: "ticket", sessionToken: redeemed.body.accessToken ?? "" },
    })).rejects.toMatchObject({ code: "VOTE_SESSION_CLOSED" });
    await expect(getClosedVoteScores(db, "vote-1")).resolves.toMatchObject({
      totalBallots: 1,
      scoreStatus: "ready",
      rawCounts: { [option?.id ?? ""]: 1, [opened.body.options[1]?.id ?? ""]: 0 },
      scoreInputs: { [option?.id ?? ""]: 100, [opened.body.options[1]?.id ?? ""]: 0 },
    });
    await expect(revokeTicket(db, deps(staff), {
      commandId: "m6-ballot-revoke-after-close",
      activityId,
      ticketId: ticket.body.ticket.id,
      reason: "撤销后不应继续计入正式结果",
    })).resolves.toMatchObject({ body: { state: "revoked" } });
    await expect(readValidVoteTally(db, "vote-1")).resolves.toEqual({
      totalBallots: 0,
      countsByOption: { [option?.id ?? ""]: 0, [opened.body.options[1]?.id ?? ""]: 0 },
    });
    await expect(getClosedVoteScores(db, "vote-1")).resolves.toMatchObject({
      totalBallots: 0,
      scoreStatus: "hold",
      holdReason: "NO_VALID_BALLOTS",
      rawCounts: { [option?.id ?? ""]: 0, [opened.body.options[1]?.id ?? ""]: 0 },
    });
    await relayOutboxOnce(db);
    await expect(getLiveState(db, activityId, "vote_session", "vote-1")).resolves.toMatchObject({
      status: "running",
      state: { status: "closed", counts: { [option?.id ?? ""]: 1 }, authoritative: false },
    });
    const rebuilt = await rebuildVotingLiveProjection(db, activityId, "vote-1", "formal");
    expect(rebuilt.state).toMatchObject({ status: "closed", counts: { [option?.id ?? ""]: 1 }, authoritative: false });
  });

  it("enforces the frozen identity policy and rejects client downgrade to anonymous", async () => {
    const browserActivity = await seedActivity("act-browser-policy", false, "browser");
    const opened = await openVoteSession(db, deps(staff), {
      commandId: "m6-browser-policy-open",
      activityId: browserActivity,
      sessionId: "m6-browser-policy-session",
      scope: "voting",
      candidateIds: ["singer-a"],
    });
    const optionId = opened.body.options[0]?.id ?? "";
    await expect(submitBallot(db, deps(judgeA), {
      commandId: "m6-browser-policy-anonymous",
      activityId: browserActivity,
      sessionId: opened.body.session.id,
      scope: "voting",
      optionIds: [optionId],
      identity: { type: "anonymous" },
    })).rejects.toMatchObject({ code: "BALLOT_IDENTITY_INVALID" });
    await expect(submitBallot(db, deps(judgeA), {
      commandId: "m6-browser-policy-ticket",
      activityId: browserActivity,
      sessionId: opened.body.session.id,
      scope: "voting",
      optionIds: [optionId],
      identity: { type: "ticket", sessionToken: "not-a-browser-credential" },
    })).rejects.toMatchObject({ code: "BALLOT_IDENTITY_INVALID" });
    await submitBallot(db, deps(judgeA), {
      commandId: "m6-browser-policy-submit",
      activityId: browserActivity,
      sessionId: opened.body.session.id,
      scope: "voting",
      optionIds: [optionId],
      identity: { type: "browser", fingerprint: "browser-a" },
    });
    await expect(submitBallot(db, deps(judgeA), {
      commandId: "m6-browser-policy-duplicate",
      activityId: browserActivity,
      sessionId: opened.body.session.id,
      scope: "voting",
      optionIds: [optionId],
      identity: { type: "browser", fingerprint: "browser-a" },
    })).rejects.toMatchObject({ code: "DUPLICATE_BALLOT" });
  });

  it("rejects a ticket from another activity without accepting a cross-activity ballot", async () => {
    const first = await seedActivity();
    const second = await seedActivity();
    const ticket = await issueTicket(db, deps(staff), { commandId: "m6-cross-ticket", activityId: second });
    const redeemed = await redeemTicketCredential(db, deps(judgeA), { commandId: "m6-cross-redeem", credential: ticket.body.credential ?? "" });
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
      identity: { type: "ticket", sessionToken: redeemed.body.accessToken ?? "" },
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
    await expect(authenticateJudgeSession(db, first.body.sessionToken ?? "")).resolves.toMatchObject({ activityId, seatId: first.body.seatId });
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

    const scoreContext = await seedJudgeScoreContext(activityId, first.body.seatId);
    const scoreStep = capabilityFixture.steps[7];
    if (scoreStep === undefined) throw new Error("Golden capability fixture is missing the post-close score step.");
    const score = Number(scoreStep.input.score);
    const scored = await submitJudgeScore(db, { ...deps(judgeA), judgeSessionToken: first.body.sessionToken }, {
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

  it("rejects repeated terminal transitions and keeps ticket sessions authoritative", async () => {
    const activityId = await seedActivity();
    const ticket = await issueTicket(db, deps(staff), { commandId: "m6-transition-ticket", activityId });
    const redeemed = await redeemTicketCredential(db, deps(judgeA), {
      commandId: "m6-transition-redeem",
      credential: ticket.body.credential ?? "",
    });
    await expect(rotateTicketCredential(db, deps(staff), {
      commandId: "m6-transition-rotate-redeemed",
      activityId,
      ticketId: ticket.body.ticket.id,
    })).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
    await expect(revokeTicket(db, deps(staff), {
      commandId: "m6-transition-revoke",
      activityId,
      ticketId: ticket.body.ticket.id,
      reason: "test",
    })).resolves.toMatchObject({ body: { state: "revoked" } });
    await expect(revokeTicket(db, deps(staff), {
      commandId: "m6-transition-revoke-again",
      activityId,
      ticketId: ticket.body.ticket.id,
      reason: "test again",
    })).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
    await expect(authenticateTicketSession(db, redeemed.body.accessToken ?? "")).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("does not close a judge entry twice", async () => {
    const activityId = await seedActivity("act-close-twice", true);
    await insertJudgeEntrySeat(db, { id: "close-twice-seat", activityId, seatKey: "seat-1", state: "available", revision: 0 });
    await closeJudgeEntry(db, deps(staff), { commandId: "m6-close-once", activityId, reason: "done" });
    await expect(closeJudgeEntry(db, deps(staff), { commandId: "m6-close-twice", activityId, reason: "done again" })).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
  });

  it("uses the execution session release when opening a vote", async () => {
    const activityId = await seedActivity("act-frozen-vote");
    await insertRelease(db, {
      activityId,
      version: 2,
      contentHash: "m6-release-2",
      capabilities: {
        voting: {
          ok: true,
          capabilityKey: "voting",
          contentHash: "voting-2",
          artifact: {
            version: 2,
            schemaVersion: 2,
            purpose: "popularity",
            selectionType: "multi",
            maxSelections: 2,
            identityPolicy: "browser",
            scoringRule: { kind: "ballot_share_percent", scale: 100, decimals: 2 },
          },
        },
      },
      executionPolicy: { declaredScopes: ["voting"], conflicts: {}, runtimeContractVersion: 1 },
      capabilityVersions: { voting: "1" },
      bindings: [],
      releasedAt: "2026-10-19T17:30:00Z",
      sourceDraftRevision: 2,
    });
    await db.updateTable("activity").set({ active_definition_version: 2 }).where("id", "=", activityId).execute();
    const opened = await openVoteSession(db, deps(staff), {
      commandId: "m6-frozen-vote-open",
      activityId,
      sessionId: "m6-frozen-vote-session",
      scope: "voting",
      candidateIds: ["singer-a"],
    });
    expect(opened.body.session.definitionVersion).toBe(1);
    expect(opened.body.session.identityPolicy).toBe("ticket");
  });

  it("fails closed when the execution release contains the legacy boolean voting artifact", async () => {
    const activityId = await seedActivity("act-legacy-voting-release");
    await db
      .updateTable("definition_release")
      .set({
        capabilities: JSON.stringify({
          ticketing: { ok: true, capabilityKey: "ticketing", contentHash: "ticketing", artifact: { schemaVersion: 1 } },
          voting: {
            ok: true,
            capabilityKey: "voting",
            contentHash: "legacy-voting",
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
        }),
      })
      .where("activity_id", "=", activityId)
      .where("version", "=", 1)
      .execute();

    await expect(openVoteSession(db, deps(staff), {
      commandId: "m6-legacy-voting-open",
      activityId,
      sessionId: "m6-legacy-voting-session",
      scope: "voting",
      candidateIds: ["singer-a"],
    })).rejects.toMatchObject({ code: "RELEASE_REISSUE_REQUIRED" });
    expect(await db.selectFrom("vote_session").select("id").where("activity_id", "=", activityId).execute()).toHaveLength(0);
  });

  it("rejects vote commands when the running execution release no longer matches", async () => {
    const activityId = await seedActivity("act-stale-vote");
    const ticket = await issueTicket(db, deps(staff), { commandId: "m6-stale-ticket", activityId });
    const redeemed = await redeemTicketCredential(db, deps(judgeA), { commandId: "m6-stale-redeem", credential: ticket.body.credential ?? "" });
    const opened = await openVoteSession(db, deps(staff), {
      commandId: "m6-stale-open",
      activityId,
      sessionId: "m6-stale-session",
      scope: "voting",
      candidateIds: ["singer-a"],
    });
    await insertRelease(db, {
      activityId,
      version: 2,
      contentHash: "m6-stale-release-2",
      capabilities: {
        voting: {
          ok: true,
          capabilityKey: "voting",
          contentHash: "voting-stale-2",
          artifact: {
            version: 2,
            schemaVersion: 2,
            purpose: "score_component",
            selectionType: "single",
            maxSelections: 1,
            identityPolicy: "ticket",
            scoringRule: { kind: "ballot_share_percent", scale: 100, decimals: 2 },
          },
        },
      },
      executionPolicy: { declaredScopes: ["voting"], conflicts: {}, runtimeContractVersion: 1 },
      capabilityVersions: { voting: "1" },
      bindings: [],
      releasedAt: "2026-10-19T17:30:00Z",
      sourceDraftRevision: 2,
    });
    await db.updateTable("execution_session").set({ definition_version: 2 }).where("activity_id", "=", activityId).where("scope", "=", "voting").execute();
    await expect(submitBallot(db, deps(judgeA), {
      commandId: "m6-stale-submit",
      activityId,
      sessionId: opened.body.session.id,
      scope: "voting",
      optionIds: [opened.body.options[0]?.id ?? ""],
      identity: { type: "ticket", sessionToken: redeemed.body.accessToken ?? "" },
    })).rejects.toMatchObject({ code: "STALE_CONTEXT" });
    await expect(closeVoteSession(db, deps(staff), {
      commandId: "m6-stale-close",
      activityId,
      sessionId: opened.body.session.id,
      scope: "voting",
      expectedRevision: 0,
    })).rejects.toMatchObject({ code: "STALE_CONTEXT" });
  });

  it("proves ticket redemption, ballot uniqueness, and judge-seat claims with two PostgreSQL connections", async () => {
    const activityId = await seedActivity("act-m6-concurrency");
    const ticket = await issueTicket(dbA, deps(staff), { commandId: "m6-concurrent-ticket", activityId });
    const redemptions = await Promise.allSettled([
      redeemTicketCredential(dbA, deps(judgeA), { commandId: "m6-concurrent-redeem-a", credential: ticket.body.credential ?? "" }),
      redeemTicketCredential(dbB, deps(judgeB), { commandId: "m6-concurrent-redeem-b", credential: ticket.body.credential ?? "" }),
    ]);
    expect(redemptions.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(redemptions.filter((result) => result.status === "rejected").map((result) => (result as PromiseRejectedResult).reason.code)).toContain("TICKET_REPLAYED");
    const redeemed = await db.selectFrom("ticket_access_session").selectAll().where("ticket_id", "=", ticket.body.ticket.id).executeTakeFirstOrThrow();
    const redeemedResult = redemptions.find((result) => result.status === "fulfilled");
    if (redeemedResult === undefined || redeemedResult.status !== "fulfilled") throw new Error("The concurrent redemption did not succeed.");
    const accessToken = redeemedResult.value.body.accessToken;
    expect(accessToken).toEqual(expect.any(String));

    const opened = await openVoteSession(dbA, deps(staff), {
      commandId: "m6-concurrent-vote-open",
      activityId,
      sessionId: "m6-concurrent-vote-session",
      scope: "voting",
      candidateIds: ["singer-a"],
    });
    const ballots = await Promise.allSettled([
      submitBallot(dbA, deps(judgeA), { commandId: "m6-concurrent-ballot-a", activityId, sessionId: opened.body.session.id, scope: "voting", optionIds: [opened.body.options[0]?.id ?? ""], identity: { type: "ticket", sessionToken: accessToken ?? "" } }),
      submitBallot(dbB, deps(judgeB), { commandId: "m6-concurrent-ballot-b", activityId, sessionId: opened.body.session.id, scope: "voting", optionIds: [opened.body.options[0]?.id ?? ""], identity: { type: "ticket", sessionToken: accessToken ?? "" } }),
    ]);
    expect(ballots.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(ballots.filter((result) => result.status === "rejected").map((result) => (result as PromiseRejectedResult).reason.code)).toContain("DUPLICATE_BALLOT");
    expect(Number((await db.selectFrom("ballot").select(({ fn }) => fn.countAll<number>().as("count")).where("session_id", "=", opened.body.session.id).executeTakeFirstOrThrow()).count)).toBe(1);
    expect(redeemed.revoked_at).toBeNull();

    const judgeActivity = await seedActivity("act-m6-judge-concurrency", true);
    await insertJudgeEntrySeat(dbA, { id: "m6-concurrent-seat", activityId: judgeActivity, seatKey: "seat-1", state: "available", revision: 0 });
    const capability = capabilityCredential("J", judgeActivity, 1, secret);
    const claims = await Promise.allSettled([
      claimJudgeSeat(dbA, deps(judgeA), { commandId: "m6-concurrent-claim-a", publicCode: judgeActivity, capability }),
      claimJudgeSeat(dbB, deps(judgeB), { commandId: "m6-concurrent-claim-b", publicCode: judgeActivity, capability }),
    ]);
    expect(claims.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(claims.filter((result) => result.status === "rejected").map((result) => (result as PromiseRejectedResult).reason.code)).toContain("SEAT_UNAVAILABLE");
    expect(Number((await db.selectFrom("judge_session").select(({ fn }) => fn.countAll<number>().as("count")).where("activity_id", "=", judgeActivity).executeTakeFirstOrThrow()).count)).toBe(1);
  });
});
