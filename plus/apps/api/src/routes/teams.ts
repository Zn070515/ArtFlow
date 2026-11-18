import { Type } from "@sinclair/typebox";

import {
  addTeamMember,
  correctTeamRoster,
  createTeam,
  freezeTeamRoster,
  getTeamsView,
  importTeamsFromGrouping,
  removeTeamMemberCommand,
  updateTeam,
  withdrawTeamCommand,
} from "@artflow-plus/runtime";

import type { ApiContext } from "../http/context.js";
import { requireIdempotency } from "../http/helpers.js";

const ActivityParams = Type.Object({ id: Type.String({ minLength: 1 }) }, { additionalProperties: false });
const TeamParams = Type.Object({
  id: Type.String({ minLength: 1 }),
  teamId: Type.String({ minLength: 1 }),
}, { additionalProperties: false });
const MemberParams = Type.Object({
  id: Type.String({ minLength: 1 }),
  teamId: Type.String({ minLength: 1 }),
  participantId: Type.String({ minLength: 1 }),
}, { additionalProperties: false });

const CreateTeamBody = Type.Object({
  teamKey: Type.String({ minLength: 1, maxLength: 40 }),
  name: Type.String({ minLength: 1, maxLength: 80 }),
}, { additionalProperties: false });

const UpdateTeamBody = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 80 }),
  expectedRevision: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false });

const AddMemberBody = Type.Object({
  participantId: Type.String({ minLength: 1, maxLength: 100 }),
  role: Type.Optional(Type.Union([Type.Literal("member"), Type.Literal("captain")])),
  expectedRevision: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false });

const RevisionBody = Type.Object({
  expectedRevision: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false });

const WithdrawBody = Type.Object({
  expectedRevision: Type.Integer({ minimum: 0 }),
  reason: Type.String({ minLength: 1, maxLength: 1000 }),
}, { additionalProperties: false });

const CorrectMember = Type.Object({
  participantId: Type.String({ minLength: 1, maxLength: 100 }),
  role: Type.Optional(Type.Union([Type.Literal("member"), Type.Literal("captain")])),
}, { additionalProperties: false });

const CorrectTeam = Type.Object({
  teamKey: Type.String({ minLength: 1, maxLength: 40 }),
  name: Type.String({ minLength: 1, maxLength: 80 }),
  members: Type.Array(CorrectMember, { maxItems: 64 }),
}, { additionalProperties: false });

const CorrectRosterBody = Type.Object({
  expectedRosterFingerprint: Type.String({ minLength: 1, maxLength: 200 }),
  reason: Type.String({ minLength: 1, maxLength: 1000 }),
  teams: Type.Array(CorrectTeam, { minItems: 1, maxItems: 128 }),
}, { additionalProperties: false });

const ImportBody = Type.Object({
  stageKey: Type.String({ minLength: 1, maxLength: 100 }),
}, { additionalProperties: false });

export function registerTeamsRoutes(ctx: ApiContext): void {
  const { app, db, requestDeps } = ctx;

  app.get("/api/activities/:id/teams", { schema: { params: ActivityParams }, config: { access: "session" } }, async (request) => {
    const { id } = request.params as { id: string };
    return await getTeamsView(db, await requestDeps(request), id);
  });

  app.post("/api/activities/:id/teams", { schema: { params: ActivityParams, body: CreateTeamBody } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { teamKey: string; name: string };
    const outcome = await createTeam(db, await requestDeps(request), {
      commandId: requireIdempotency(request),
      activityId: id,
      ...body,
    });
    return reply.status(outcome.status).send(outcome.body);
  });

  app.put("/api/activities/:id/teams/:teamId", { schema: { params: TeamParams, body: UpdateTeamBody } }, async (request) => {
    const { id, teamId } = request.params as { id: string; teamId: string };
    const body = request.body as { name: string; expectedRevision: number };
    const outcome = await updateTeam(db, await requestDeps(request), {
      commandId: requireIdempotency(request),
      activityId: id,
      teamId,
      ...body,
    });
    return outcome.body;
  });

  app.post("/api/activities/:id/teams/:teamId/members", { schema: { params: TeamParams, body: AddMemberBody } }, async (request) => {
    const { id, teamId } = request.params as { id: string; teamId: string };
    const body = request.body as { participantId: string; role?: string; expectedRevision: number };
    const outcome = await addTeamMember(db, await requestDeps(request), {
      commandId: requireIdempotency(request),
      activityId: id,
      teamId,
      ...body,
    });
    return outcome.body;
  });

  app.post("/api/activities/:id/teams/:teamId/members/:participantId/remove", { schema: { params: MemberParams, body: RevisionBody } }, async (request) => {
    const { id, teamId, participantId } = request.params as { id: string; teamId: string; participantId: string };
    const body = request.body as { expectedRevision: number };
    const outcome = await removeTeamMemberCommand(db, await requestDeps(request), {
      commandId: requireIdempotency(request),
      activityId: id,
      teamId,
      participantId,
      expectedRevision: body.expectedRevision,
    });
    return outcome.body;
  });

  app.post("/api/activities/:id/teams/:teamId/withdraw", { schema: { params: TeamParams, body: WithdrawBody } }, async (request) => {
    const { id, teamId } = request.params as { id: string; teamId: string };
    const body = request.body as { expectedRevision: number; reason: string };
    const outcome = await withdrawTeamCommand(db, await requestDeps(request), {
      commandId: requireIdempotency(request),
      activityId: id,
      teamId,
      ...body,
    });
    return outcome.body;
  });

  app.post("/api/activities/:id/teams/freeze", { schema: { params: ActivityParams } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const outcome = await freezeTeamRoster(db, await requestDeps(request), {
      commandId: requireIdempotency(request),
      activityId: id,
    });
    return reply.status(outcome.status).send(outcome.body);
  });

  app.post("/api/activities/:id/teams/correct", { schema: { params: ActivityParams, body: CorrectRosterBody } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as {
      expectedRosterFingerprint: string;
      reason: string;
      teams: readonly {
        teamKey: string;
        name: string;
        members: readonly { participantId: string; role?: "member" | "captain" }[];
      }[];
    };
    const outcome = await correctTeamRoster(db, await requestDeps(request), {
      commandId: requireIdempotency(request),
      activityId: id,
      ...body,
    });
    return reply.status(outcome.status).send(outcome.body);
  });

  app.post("/api/activities/:id/teams/import", { schema: { params: ActivityParams, body: ImportBody } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { stageKey: string };
    const outcome = await importTeamsFromGrouping(db, await requestDeps(request), {
      commandId: requireIdempotency(request),
      activityId: id,
      stageKey: body.stageKey,
    });
    return reply.status(outcome.status).send(outcome.body);
  });
}
