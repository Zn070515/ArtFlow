import type { ApiContext } from "../http/context.js";
import { DomainError } from "@artflow-plus/domain";
import { cancelGroupingStage, confirmGroupingStage, correctGroupingStage, createGroupingStage, freezeGroupingStage, getGroupingState, recordGroupingGroups, setGroupingMaterialWindow } from "@artflow-plus/runtime";
import { ActivityParams, CancelGroupingBody, CorrectGroupingBody, CreateGroupingStageBody, GroupingRevisionBody, GroupingStageParams, GroupingWindowBody, RecordGroupingGroupsBody } from "../http/schemas.js";
import { requireIdempotency } from "../http/helpers.js";

export function registerGroupingRoutes(ctx: ApiContext): void {
  const {
    app, db, deps, baseDeps, registry, packs, rateLimiter, isProduction,
    sessionSecret, enableRuntimeFacts,
    setSessionCookies, clearSessionCookies, publicActor, requestSession,
    requestActor, requestDeps, requireStudio, requireOperationsReader,
    requireReadAccess, requireSessionManager, publicDeps, judgeScoreDeps,
    requireRateLimit, requirePublicRateLimit, routeRound,
  } = ctx;

  app.get(
    "/api/activities/:id/grouping",
    { schema: { params: ActivityParams }, config: { access: "session" } },
    async (request) => {
      const { id } = request.params as { id: string };
      return getGroupingState(db, await requestDeps(request), { activityId: id });
    },
  );

  app.post(
    "/api/activities/:id/grouping/stages",
    { schema: { params: ActivityParams, body: CreateGroupingStageBody } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id } = request.params as { id: string };
      const body = request.body as {
        stageKey: string;
        name: string;
        rosterSource: "all_approved" | "round_advanced";
        sourceRoundId?: string;
      };
      const outcome = await createGroupingStage(db, await requestDeps(request), {
        commandId,
        activityId: id,
        stageKey: body.stageKey,
        name: body.name,
        rosterSource: body.rosterSource,
        ...(body.sourceRoundId === undefined ? {} : { sourceRoundId: body.sourceRoundId }),
      });
      const state = await getGroupingState(db, await requestDeps(request), { activityId: id });
      const view = state.stages.find((stage) => stage.id === outcome.body.id);
      if (view === undefined) throw new DomainError("NOT_FOUND", "The grouping stage was not found.");
      return reply.status(outcome.status).send(view);
    },
  );

  app.patch(
    "/api/activities/:id/grouping/stages/:stageId/groups",
    { schema: { params: GroupingStageParams, body: RecordGroupingGroupsBody } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id, stageId } = request.params as { id: string; stageId: string };
      const body = request.body as {
        expectedRevision: number;
        groups: readonly { name?: string; participantIds: readonly string[] }[];
      };
      const outcome = await recordGroupingGroups(db, await requestDeps(request), {
        commandId,
        activityId: id,
        stageId,
        expectedRevision: body.expectedRevision,
        groups: body.groups,
      });
      const state = await getGroupingState(db, await requestDeps(request), { activityId: id });
      const view = state.stages.find((stage) => stage.id === stageId);
      if (view === undefined) throw new DomainError("NOT_FOUND", "The grouping stage was not found.");
      return reply.status(outcome.status).send(view);
    },
  );

  app.post(
    "/api/activities/:id/grouping/stages/:stageId/confirm",
    { schema: { params: GroupingStageParams, body: GroupingRevisionBody } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id, stageId } = request.params as { id: string; stageId: string };
      const body = request.body as { expectedRevision: number };
      const outcome = await confirmGroupingStage(db, await requestDeps(request), {
        commandId,
        activityId: id,
        stageId,
        expectedRevision: body.expectedRevision,
      });
      const state = await getGroupingState(db, await requestDeps(request), { activityId: id });
      const view = state.stages.find((stage) => stage.id === stageId);
      if (view === undefined) throw new DomainError("NOT_FOUND", "The grouping stage was not found.");
      return reply.status(outcome.status).send(view);
    },
  );

  app.post(
    "/api/activities/:id/grouping/stages/:stageId/freeze",
    { schema: { params: GroupingStageParams, body: GroupingRevisionBody } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id, stageId } = request.params as { id: string; stageId: string };
      const body = request.body as { expectedRevision: number };
      const outcome = await freezeGroupingStage(db, await requestDeps(request), {
        commandId,
        activityId: id,
        stageId,
        expectedRevision: body.expectedRevision,
      });
      const state = await getGroupingState(db, await requestDeps(request), { activityId: id });
      const view = state.stages.find((stage) => stage.id === stageId);
      if (view === undefined) throw new DomainError("NOT_FOUND", "The grouping stage was not found.");
      return reply.status(outcome.status).send(view);
    },
  );

  app.post(
    "/api/activities/:id/grouping/stages/:stageId/correct",
    { schema: { params: GroupingStageParams, body: CorrectGroupingBody } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id, stageId } = request.params as { id: string; stageId: string };
      const body = request.body as {
        expectedRevision: number;
        groups: readonly { name?: string; participantIds: readonly string[] }[];
        reason: string;
      };
      const outcome = await correctGroupingStage(db, await requestDeps(request), {
        commandId,
        activityId: id,
        stageId,
        expectedRevision: body.expectedRevision,
        groups: body.groups,
        reason: body.reason,
      });
      const state = await getGroupingState(db, await requestDeps(request), { activityId: id });
      const view = state.stages.find((stage) => stage.id === stageId);
      if (view === undefined) throw new DomainError("NOT_FOUND", "The grouping stage was not found.");
      return reply.status(outcome.status).send(view);
    },
  );

  app.post(
    "/api/activities/:id/grouping/stages/:stageId/cancel",
    { schema: { params: GroupingStageParams, body: CancelGroupingBody } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id, stageId } = request.params as { id: string; stageId: string };
      const body = request.body as { expectedRevision: number; reason: string };
      const outcome = await cancelGroupingStage(db, await requestDeps(request), {
        commandId,
        activityId: id,
        stageId,
        expectedRevision: body.expectedRevision,
        reason: body.reason,
      });
      const state = await getGroupingState(db, await requestDeps(request), { activityId: id });
      const view = state.stages.find((stage) => stage.id === stageId);
      if (view === undefined) throw new DomainError("NOT_FOUND", "The grouping stage was not found.");
      return reply.status(outcome.status).send(view);
    },
  );

  app.patch(
    "/api/activities/:id/grouping/stages/:stageId/window",
    { schema: { params: GroupingStageParams, body: GroupingWindowBody } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id, stageId } = request.params as { id: string; stageId: string };
      const body = request.body as {
        expectedRevision: number;
        window: "closed" | "open" | "supplement_only";
        note?: string;
      };
      const outcome = await setGroupingMaterialWindow(db, await requestDeps(request), {
        commandId,
        activityId: id,
        stageId,
        expectedRevision: body.expectedRevision,
        window: body.window,
        ...(body.note === undefined ? {} : { note: body.note }),
      });
      const state = await getGroupingState(db, await requestDeps(request), { activityId: id });
      const view = state.stages.find((stage) => stage.id === stageId);
      if (view === undefined) throw new DomainError("NOT_FOUND", "The grouping stage was not found.");
      return reply.status(outcome.status).send(view);
    },
  );
}
