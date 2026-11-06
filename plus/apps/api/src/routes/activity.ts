import type { ApiContext } from "../http/context.js";
import { ActivityAnalyticsParamsSchema, ActivityAnalyticsResponseSchema, CloseActivityBodySchema, CloseExecutionBodySchema, RenameActivityBodySchema, StartExecutionBodySchema, errorResponse } from "@artflow-plus/contracts";
import { getOutboxRelayHealth } from "@artflow-plus/db";
import { DomainError, instantiateActivityPack } from "@artflow-plus/domain";
import type { ActivityDefinitionPackage, ExecutionMode } from "@artflow-plus/domain";
import { activateActivity, appendRuntimeFact, closeActivity, closeExecution, compileDefinition, createActivity, getActivity, getActivityAnalytics, getExecutionState, getStudioState, listActivitiesForReview, listEvents, listExecutions, releaseDefinitionCommand, renameActivity, startExecution } from "@artflow-plus/runtime";
import { ActivateBody, ActivityParams, CompileBody, CreateActivityBody, EventsQuery, ReleaseBody, RuntimeFactBody, SessionParams, StateQuery } from "../http/schemas.js";
import { asPackage, requireIdempotency } from "../http/helpers.js";

export function registerActivityRoutes(ctx: ApiContext): void {
  const {
    app, db, deps, baseDeps, registry, packs, rateLimiter, isProduction,
    sessionSecret, enableRuntimeFacts,
    setSessionCookies, clearSessionCookies, publicActor, requestSession,
    requestActor, requestDeps, requireStudio, requireOperationsReader,
    requireReadAccess, requireSessionManager, publicDeps, judgeScoreDeps,
    requireRateLimit, requirePublicRateLimit, routeRound,
  } = ctx;

  app.post(
    "/api/activities",
    { schema: { body: CreateActivityBody } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const body = request.body as {
        title: string;
        capabilities?: string[];
        packId?: string;
        answers?: Record<string, boolean>;
        enable?: string[];
        disable?: string[];
      };
      let capabilities = body.capabilities;
      let initialDefinition: ActivityDefinitionPackage | undefined;
      if (body.packId !== undefined) {
        const pack = packs.find((candidate) => candidate.identity === body.packId);
        if (pack === undefined) {
          throw new DomainError("NOT_FOUND", `Pack ${body.packId} was not found.`);
        }
        const instantiated = instantiateActivityPack(pack, registry, {
          title: body.title,
          ...(body.answers === undefined ? {} : { answers: body.answers }),
          ...(body.enable === undefined ? {} : { enable: body.enable }),
          ...(body.disable === undefined ? {} : { disable: body.disable }),
        });
        if (!instantiated.ok) {
          return reply
            .status(422)
            .send(
              errorResponse(
                "PACK_COMPOSITION_INVALID",
                `Pack ${body.packId} cannot be instantiated.`,
                instantiated.issues,
              ),
            );
        }
        capabilities = [...instantiated.instantiation.enabledCapabilities];
        initialDefinition = instantiated.instantiation.definition;
      }
      const outcome = await createActivity(db, registry, await requireStudio(request), {
        commandId,
        title: body.title,
        ...(capabilities === undefined ? {} : { capabilities }),
        ...(initialDefinition === undefined ? {} : { initialDefinition }),
      });
      return reply.status(outcome.status).send(outcome.body);
    },
  );

  app.get("/api/activities", { config: { access: "session" } }, async (request) => ({
    activities: await listActivitiesForReview(db, await requestDeps(request)),
  }));

  app.get(
    "/api/activities/:id/studio",
    { schema: { params: ActivityParams }, config: { access: "studio" } },
    async (request) => {
      const { id } = request.params as { id: string };
      return getStudioState(db, await requireStudio(request), id);
    },
  );

  app.get("/api/activities/:id", { schema: { params: ActivityParams }, config: { access: "operations" } }, async (request) => {
    const { id } = request.params as { id: string };
    const activity = await getActivity(db, id);
    if (activity === null) {
      throw new DomainError("NOT_FOUND", `Activity ${id} was not found.`);
    }
    return activity;
  });

  app.get(
    "/api/activities/:id/operations/analytics",
    {
      schema: {
        params: ActivityAnalyticsParamsSchema,
        response: { 200: ActivityAnalyticsResponseSchema },
      },
      config: { access: "analytics" },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      return getActivityAnalytics(db, await requestDeps(request), id);
    },
  );

  app.get("/api/operations/outbox", { config: { access: "operations" } }, async () => {
    return getOutboxRelayHealth(db);
  });

  app.post(
    "/api/activities/:id/activate",
    { schema: { params: ActivityParams, body: ActivateBody } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id } = request.params as { id: string };
      const body = request.body as { expectedRevision: number };
      const outcome = await activateActivity(db, await requireStudio(request), {
        commandId,
        activityId: id,
        expectedRevision: body.expectedRevision,
      });
      return reply.status(outcome.status).send(outcome.body);
    },
  );

  app.post(
    "/api/activities/:id/definitions/compile",
    { schema: { params: ActivityParams, body: CompileBody } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id } = request.params as { id: string };
      const body = request.body as {
        package: unknown;
        expectedDraftRevision?: number;
      };
      const outcome = await compileDefinition(db, registry, await requireStudio(request), {
        commandId,
        activityId: id,
        package: asPackage(body.package),
        ...(body.expectedDraftRevision === undefined
          ? {}
          : { expectedDraftRevision: body.expectedDraftRevision }),
      });
      return reply.status(outcome.status).send(outcome.body);
    },
  );

  app.post(
    "/api/activities/:id/definitions/release",
    { schema: { params: ActivityParams, body: ReleaseBody } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id } = request.params as { id: string };
      const body = request.body as { expectedDraftRevision: number };
      const outcome = await releaseDefinitionCommand(db, registry, await requireStudio(request), {
        commandId,
        activityId: id,
        expectedDraftRevision: body.expectedDraftRevision,
      });
      return reply.status(outcome.status).send(outcome.body);
    },
  );

  app.post(
    "/api/activities/:id/executions",
    { schema: { params: ActivityParams, body: StartExecutionBodySchema } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id } = request.params as { id: string };
      const body = request.body as {
        scope: string;
        mode: ExecutionMode;
        expectedRevision?: number;
      };
      const outcome = await startExecution(db, registry, await requireSessionManager(request), {
        commandId,
        activityId: id,
        scope: body.scope,
        mode: body.mode,
        ...(body.expectedRevision === undefined
          ? {}
          : { expectedRevision: body.expectedRevision }),
      });
      return reply.status(outcome.status).send(outcome.body);
    },
  );

  app.post(
    "/api/activities/:id/executions/:sessionId/close",
    { schema: { params: SessionParams, body: CloseExecutionBodySchema } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id, sessionId } = request.params as { id: string; sessionId: string };
      const body = request.body as { expectedRevision: number };
      const outcome = await closeExecution(db, await requireSessionManager(request), {
        commandId,
        activityId: id,
        sessionId,
        expectedRevision: body.expectedRevision,
      });
      return reply.status(outcome.status).send(outcome.body);
    },
  );

  app.get(
    "/api/activities/:id/executions",
    { schema: { params: ActivityParams }, config: { access: "operations" } },
    async (request) => {
      const { id } = request.params as { id: string };
      const activity = await getActivity(db, id);
      if (activity === null) {
        throw new DomainError("NOT_FOUND", `Activity ${id} was not found.`);
      }
      return { sessions: await listExecutions(db, id) };
    },
  );

  app.get(
    "/api/activities/:id/execution-state",
    { schema: { params: ActivityParams, querystring: StateQuery }, config: { access: "operations" } },
    async (request) => {
      const { id } = request.params as { id: string };
      const query = request.query as { mode?: ExecutionMode };
      const activity = await getActivity(db, id);
      if (activity === null) {
        throw new DomainError("NOT_FOUND", `Activity ${id} was not found.`);
      }
      return getExecutionState(db, id, query.mode ?? "formal");
    },
  );

  app.get(
    "/api/activities/:id/events",
    { schema: { params: ActivityParams, querystring: EventsQuery }, config: { access: "operations" } },
    async (request) => {
      const { id } = request.params as { id: string };
      const query = request.query as {
        after?: number;
        limit?: number;
        mode?: ExecutionMode;
      };
      const activity = await getActivity(db, id);
      if (activity === null) {
        throw new DomainError("NOT_FOUND", `Activity ${id} was not found.`);
      }
      return listEvents(db, {
        activityId: id,
        after: query.after ?? 0,
        limit: query.limit ?? 100,
        ...(query.mode === undefined ? {} : { mode: query.mode }),
      });
    },
  );

  app.post(
    "/api/activities/:id/close",
    { schema: { params: ActivityParams, body: CloseActivityBodySchema } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id } = request.params as { id: string };
      const body = request.body as { expectedRevision: number };
      const outcome = await closeActivity(db, await requestDeps(request), {
        commandId,
        activityId: id,
        expectedRevision: body.expectedRevision,
      });
      return reply.status(outcome.status).send(outcome.body);
    },
  );

  app.patch(
    "/api/activities/:id/title",
    { schema: { params: ActivityParams, body: RenameActivityBodySchema } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id } = request.params as { id: string };
      const body = request.body as { title: string; expectedRevision: number };
      const outcome = await renameActivity(db, await requestDeps(request), {
        commandId,
        activityId: id,
        title: body.title,
        expectedRevision: body.expectedRevision,
      });
      return reply.status(outcome.status).send(outcome.body);
    },
  );

  if (enableRuntimeFacts) {
    app.post(
      "/api/activities/:id/runtime-facts",
      { schema: { params: ActivityParams, body: RuntimeFactBody } },
      async (request, reply) => {
        const commandId = requireIdempotency(request);
        const { id } = request.params as { id: string };
        const body = request.body as {
          capability: string;
          scope: string;
          type: string;
          payload: unknown;
        };
        const outcome = await appendRuntimeFact(db, registry, deps, {
          commandId,
          activityId: id,
          capability: body.capability,
          scope: body.scope,
          type: body.type,
          payload: body.payload,
        });
        return reply.status(outcome.status).send(outcome.body);
      },
    );
  }
}
