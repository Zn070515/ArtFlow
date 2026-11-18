import { randomUUID } from "node:crypto";

import { closeDb, createDb, insertRelease, migrate } from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import {
  compileTeamsDefinition,
  createTeamsDefinition,
  type ActorContext,
  type TeamsSource,
} from "@artflow-plus/domain";
import { Client } from "pg";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  addTeamMember,
  correctTeamRoster,
  createTeam,
  freezeTeamRoster,
  getTeamsView,
  importTeamsFromGrouping,
  removeTeamMemberCommand,
  withdrawTeamCommand,
} from "../src/index.js";
import type { RuntimeDeps } from "../src/index.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_teams_${Date.now()}_${process.pid}`;

let db: Kysely<Database>;
let admin: Client;

const actor: ActorContext = {
  actorId: "teams-manager",
  actorType: "user",
  roles: ["staff"],
  permissions: ["teams.manage"],
};

const adminActor: ActorContext = {
  actorId: "teams-admin",
  actorType: "user",
  roles: ["admin"],
  permissions: ["teams.manage", "teams.roster.correct"],
};

function deps(user: ActorContext = actor): RuntimeDeps {
  return {
    now: () => "2026-11-18T10:00:00.000Z",
    newEventId: () => randomUUID(),
    actor: user,
  };
}

async function seedActivity(options: {
  readonly minSize?: number;
  readonly maxSize?: number;
  readonly requireCaptain?: boolean;
  readonly source?: TeamsSource;
  readonly participants?: readonly { readonly id: string; readonly status?: string }[];
} = {}): Promise<string> {
  const activityId = `teams-${randomUUID().slice(0, 12)}`;
  const participants = options.participants ?? [
    { id: `p1-${randomUUID().slice(0, 8)}` },
    { id: `p2-${randomUUID().slice(0, 8)}` },
    { id: `p3-${randomUUID().slice(0, 8)}` },
    { id: `p4-${randomUUID().slice(0, 8)}`, status: "submitted" },
  ];
  const artifact = compileTeamsDefinition(createTeamsDefinition({
    minSize: options.minSize ?? 1,
    maxSize: options.maxSize ?? 3,
    requireCaptain: options.requireCaptain ?? false,
    source: options.source ?? "manual",
  }));
  if (!artifact.ok) throw new Error(JSON.stringify(artifact));
  await db.insertInto("activity").values({
    id: activityId,
    title: "Teams runtime",
    status: "active",
    revision: 1,
    enabled_capabilities: JSON.stringify(["registration", "teams"]),
    active_definition_version: 1,
  }).execute();
  for (const participant of participants) {
    await db.insertInto("registration").values({
      id: `registration-${activityId}-${participant.id}`,
      activity_id: activityId,
      participant_id: participant.id,
      questionnaire_version: "v1",
      questionnaire_hash: "hash",
      status: participant.status ?? "approved",
      answers: JSON.stringify({ name: participant.id.split("-")[0] ?? participant.id }),
      revision: 1,
      review_note: "",
      reviewed_by: "staff",
      created_at: new Date(),
      updated_at: new Date(),
    }).execute();
  }
  await insertRelease(db, {
    activityId,
    version: 1,
    contentHash: `teams-release-${activityId}`,
    capabilities: { teams: artifact },
    executionPolicy: {
      declaredScopes: [],
      conflicts: {},
      runtimeContractVersion: 2,
      commandScopes: {},
    },
    capabilityVersions: { teams: "1.0.0" },
    bindings: [],
    releasedAt: "2026-11-18T09:00:00Z",
    sourceDraftRevision: 1,
  });
  return activityId;
}

function participantIds(view: Awaited<ReturnType<typeof getTeamsView>>): string[] {
  return view.participants.map((participant) => participant.participantId);
}

async function team(activityId: string, teamKey: string, name = teamKey) {
  return await createTeam(db, deps(), {
    commandId: randomUUID(),
    activityId,
    teamKey,
    name,
  });
}

describe.skipIf(!connectionString)("teams roster", () => {
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

  it("freezes a valid roster and exposes a stable fingerprint", async () => {
    const activityId = await seedActivity();
    const view = await getTeamsView(db, deps(), activityId);
    const [p1, p2] = participantIds(view);
    if (p1 === undefined || p2 === undefined) throw new Error("seed participants missing");

    const created = await team(activityId, "alpha", "Alpha");
    const added = await addTeamMember(db, deps(), {
      commandId: randomUUID(),
      activityId,
      teamId: created.body.id,
      participantId: p1,
      expectedRevision: created.body.revision,
    });
    expect(added.body.revision).toBe(1);

    const frozen = await freezeTeamRoster(db, deps(), { commandId: randomUUID(), activityId });
    expect(frozen.body.frozenCount).toBe(1);
    const after = await getTeamsView(db, deps(), activityId);
    expect(after.rosterFrozen).toBe(true);
    expect(after.rosterFingerprint).toBe(frozen.body.rosterFingerprint);
    expect(after.teams[0]?.status).toBe("frozen");

    await expect(addTeamMember(db, deps(), {
      commandId: randomUUID(),
      activityId,
      teamId: created.body.id,
      participantId: p2,
      expectedRevision: after.teams[0]?.revision ?? 0,
    })).rejects.toMatchObject({ code: "TEAM_ROSTER_FROZEN" });
  });

  it("rejects one participant joining two teams", async () => {
    const activityId = await seedActivity();
    const view = await getTeamsView(db, deps(), activityId);
    const [p1] = participantIds(view);
    if (p1 === undefined) throw new Error("seed participant missing");
    const first = await team(activityId, "alpha", "Alpha");
    await addTeamMember(db, deps(), {
      commandId: randomUUID(),
      activityId,
      teamId: first.body.id,
      participantId: p1,
      expectedRevision: 0,
    });
    const second = await team(activityId, "beta", "Beta");
    await expect(addTeamMember(db, deps(), {
      commandId: randomUUID(),
      activityId,
      teamId: second.body.id,
      participantId: p1,
      expectedRevision: 0,
    })).rejects.toMatchObject({ code: "TEAM_MEMBER_EXISTS" });
  });

  it("rejects pending participants", async () => {
    const activityId = await seedActivity();
    const pending = await db.selectFrom("registration")
      .select("participant_id")
      .where("activity_id", "=", activityId)
      .where("status", "=", "submitted")
      .executeTakeFirstOrThrow();
    const created = await team(activityId, "alpha", "Alpha");
    await expect(addTeamMember(db, deps(), {
      commandId: randomUUID(),
      activityId,
      teamId: created.body.id,
      participantId: pending.participant_id,
      expectedRevision: 0,
    })).rejects.toMatchObject({ code: "TEAM_MEMBER_UNKNOWN" });
  });

  it("enforces minimum size and captain rules at freeze", async () => {
    const tooSmall = await seedActivity({ minSize: 2 });
    const smallView = await getTeamsView(db, deps(), tooSmall);
    const [smallP1] = participantIds(smallView);
    const smallTeam = await team(tooSmall, "alpha", "Alpha");
    if (smallP1 === undefined) throw new Error("seed participant missing");
    await addTeamMember(db, deps(), {
      commandId: randomUUID(),
      activityId: tooSmall,
      teamId: smallTeam.body.id,
      participantId: smallP1,
      expectedRevision: 0,
    });
    await expect(freezeTeamRoster(db, deps(), { commandId: randomUUID(), activityId: tooSmall }))
      .rejects.toMatchObject({ code: "TEAM_SIZE_INVALID" });

    const needsCaptain = await seedActivity({ requireCaptain: true });
    const captainView = await getTeamsView(db, deps(), needsCaptain);
    const [captainP1] = participantIds(captainView);
    const captainTeam = await team(needsCaptain, "alpha", "Alpha");
    if (captainP1 === undefined) throw new Error("seed participant missing");
    await addTeamMember(db, deps(), {
      commandId: randomUUID(),
      activityId: needsCaptain,
      teamId: captainTeam.body.id,
      participantId: captainP1,
      expectedRevision: 0,
    });
    await expect(freezeTeamRoster(db, deps(), { commandId: randomUUID(), activityId: needsCaptain }))
      .rejects.toMatchObject({ code: "TEAM_CAPTAIN_REQUIRED" });
  });

  it("corrects a frozen roster and withdraws omitted teams", async () => {
    const activityId = await seedActivity();
    const view = await getTeamsView(db, deps(), activityId);
    const [p1, p2, p3] = participantIds(view);
    if (p1 === undefined || p2 === undefined || p3 === undefined) throw new Error("seed participants missing");
    const alpha = await team(activityId, "alpha", "Alpha");
    const beta = await team(activityId, "beta", "Beta");
    await addTeamMember(db, deps(), {
      commandId: randomUUID(),
      activityId,
      teamId: alpha.body.id,
      participantId: p1,
      expectedRevision: 0,
    });
    const betaWithP3 = await addTeamMember(db, deps(), {
      commandId: randomUUID(),
      activityId,
      teamId: beta.body.id,
      participantId: p3,
      expectedRevision: 0,
    });
    await addTeamMember(db, deps(), {
      commandId: randomUUID(),
      activityId,
      teamId: beta.body.id,
      participantId: p2,
      expectedRevision: betaWithP3.body.revision,
    });
    const frozen = await freezeTeamRoster(db, deps(), { commandId: randomUUID(), activityId });

    await expect(correctTeamRoster(db, deps(adminActor), {
      commandId: randomUUID(),
      activityId,
      expectedRosterFingerprint: "stale",
      reason: "fix",
      teams: [{ teamKey: "alpha", name: "Alpha", members: [{ participantId: p1 }] }],
    })).rejects.toMatchObject({ code: "STALE_REVISION" });

    const corrected = await correctTeamRoster(db, deps(adminActor), {
      commandId: randomUUID(),
      activityId,
      expectedRosterFingerprint: frozen.body.rosterFingerprint,
      reason: "fix names",
      teams: [{
        teamKey: "alpha",
        name: "Alpha Two",
        members: [
          { participantId: p1, role: "member" },
          { participantId: p2, role: "member" },
        ],
      }],
    });
    expect(corrected.body.rosterFingerprint).not.toBe(frozen.body.rosterFingerprint);
    const after = await getTeamsView(db, deps(), activityId);
    const alphaAfter = after.teams.find((item) => item.teamKey === "alpha");
    const betaAfter = after.teams.find((item) => item.teamKey === "beta");
    expect(alphaAfter).toMatchObject({ name: "Alpha Two", status: "frozen" });
    expect(alphaAfter?.members).toHaveLength(2);
    expect(betaAfter).toMatchObject({ status: "withdrawn", withdrawReason: "fix names" });
  });

  it("releases members when a team withdraws", async () => {
    const activityId = await seedActivity();
    const view = await getTeamsView(db, deps(), activityId);
    const [p1] = participantIds(view);
    if (p1 === undefined) throw new Error("seed participant missing");
    const alpha = await team(activityId, "alpha", "Alpha");
    await addTeamMember(db, deps(), {
      commandId: randomUUID(),
      activityId,
      teamId: alpha.body.id,
      participantId: p1,
      expectedRevision: 0,
    });
    await freezeTeamRoster(db, deps(), { commandId: randomUUID(), activityId });
    const frozenView = await getTeamsView(db, deps(), activityId);
    const frozenTeam = frozenView.teams[0];
    if (frozenTeam === undefined) throw new Error("team missing");
    await withdrawTeamCommand(db, deps(), {
      commandId: randomUUID(),
      activityId,
      teamId: frozenTeam.id,
      expectedRevision: frozenTeam.revision,
      reason: "withdrew",
    });
    const next = await team(activityId, "beta", "Beta");
    const readded = await addTeamMember(db, deps(), {
      commandId: randomUUID(),
      activityId,
      teamId: next.body.id,
      participantId: p1,
      expectedRevision: 0,
    });
    expect(readded.body.revision).toBe(1);

    const nextView = await getTeamsView(db, deps(), activityId);
    const beta = nextView.teams.find((item) => item.teamKey === "beta");
    if (beta === undefined) throw new Error("beta missing");
    await removeTeamMemberCommand(db, deps(), {
      commandId: randomUUID(),
      activityId,
      teamId: beta.id,
      participantId: p1,
      expectedRevision: beta.revision,
    });
    const emptied = await getTeamsView(db, deps(), activityId);
    expect(emptied.teams.find((item) => item.teamKey === "beta")?.members).toHaveLength(0);
  });

  it("imports a frozen grouping stage when the definition asks for it", async () => {
    const activityId = await seedActivity({ source: "grouping" });
    const view = await getTeamsView(db, deps(), activityId);
    const [p1, p2, p3] = participantIds(view);
    if (p1 === undefined || p2 === undefined || p3 === undefined) throw new Error("seed participants missing");
    const stageId = `stage-${randomUUID()}`;
    await db.insertInto("grouping_stage").values({
      id: stageId,
      activity_id: activityId,
      stage_key: "groups",
      name: "分组",
      status: "frozen",
      roster_source: "all_approved",
      source_round_id: null,
      source_fingerprint: "grouping-fingerprint",
      material_window: "closed",
      cancel_reason: "",
      confirmed_at: new Date(),
      confirmed_by: "staff",
      frozen_at: new Date(),
      frozen_by: "staff",
      cancelled_at: null,
      cancelled_by: null,
      revision: 3,
      created_at: new Date(),
      updated_at: new Date(),
    }).execute();
    const groupA = `group-a-${randomUUID()}`;
    const groupB = `group-b-${randomUUID()}`;
    await db.insertInto("grouping_group").values([
      { id: groupA, stage_id: stageId, group_order: 1, name: "甲组", is_active: true, created_at: new Date(), updated_at: new Date() },
      { id: groupB, stage_id: stageId, group_order: 2, name: "乙组", is_active: true, created_at: new Date(), updated_at: new Date() },
    ]).execute();
    await db.insertInto("grouping_membership").values([
      { id: `m1-${randomUUID()}`, stage_id: stageId, group_id: groupA, participant_id: p1, is_current: true, joined_at: "2026-11-18T09:00:00Z", left_at: null, removed_by: null, reason: "" },
      { id: `m2-${randomUUID()}`, stage_id: stageId, group_id: groupA, participant_id: p2, is_current: true, joined_at: "2026-11-18T09:00:00Z", left_at: null, removed_by: null, reason: "" },
      { id: `m3-${randomUUID()}`, stage_id: stageId, group_id: groupB, participant_id: p3, is_current: true, joined_at: "2026-11-18T09:00:00Z", left_at: null, removed_by: null, reason: "" },
    ]).execute();

    const imported = await importTeamsFromGrouping(db, deps(), {
      commandId: randomUUID(),
      activityId,
      stageKey: "groups",
    });
    expect(imported.body.frozenCount).toBe(0);
    const after = await getTeamsView(db, deps(), activityId);
    expect(after.teams).toHaveLength(2);
    expect(after.teams.map((item) => item.teamKey).sort()).toEqual(["group-1", "group-2"]);
    expect(after.teams.find((item) => item.teamKey === "group-1")?.members).toHaveLength(2);
    expect(after.teams[0]?.source).toBe("grouping");
  });

  it("refuses manual teams when the definition imports from grouping", async () => {
    const activityId = await seedActivity({ source: "grouping" });
    await expect(team(activityId, "alpha", "Alpha"))
      .rejects.toMatchObject({ code: "TEAM_SOURCE_MISMATCH" });
  });
});
