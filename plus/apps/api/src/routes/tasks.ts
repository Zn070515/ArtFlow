import type { ApiContext } from "../http/context.js";
import { AssignTaskBodySchema, ReadinessResponseSchema, RevisionBodySchema as TaskRevisionBodySchema, SyncTaskBodySchema, TaskListResponseSchema, TaskParamsSchema, TaskReasonBodySchema, TaskResponseSchema, TaskSyncResponseSchema } from "@artflow-plus/contracts";
import { SYSTEM_ACTOR } from "@artflow-plus/domain";
import { assignTask, blockTask, completeTask, listTasks, readReadiness, reopenTask, startTask, syncTasks } from "@artflow-plus/runtime";
import { ActivityParams } from "../http/schemas.js";
import { compileClosedTypeBoxSchema, requireIdempotency } from "../http/helpers.js";

export function registerTasksRoutes(ctx: ApiContext): void {
  const {
    app, db, deps, baseDeps, registry, packs, rateLimiter, isProduction,
    sessionSecret, enableRuntimeFacts,
    setSessionCookies, clearSessionCookies, publicActor, requestSession,
    requestActor, requestDeps, requireStudio, requireOperationsReader,
    requireReadAccess, requireSessionManager, publicDeps, judgeScoreDeps,
    requireRateLimit, requirePublicRateLimit, routeRound,
  } = ctx;

  app.get(
    "/api/activities/:id/tasks",
    {
      schema: { params: ActivityParams, response: { 200: TaskListResponseSchema } },
      config: { access: "tasks" },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      return listTasks(db, await requestDeps(request), id);
    },
  );

  app.get(
    "/api/activities/:id/readiness",
    {
      schema: { params: ActivityParams, response: { 200: ReadinessResponseSchema } },
      config: { access: "tasks" },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      return readReadiness(db, await requestDeps(request), id);
    },
  );

  app.post(
    "/api/activities/:id/tasks/sync",
    {
      schema: {
        params: ActivityParams,
        body: SyncTaskBodySchema,
        response: { 200: TaskSyncResponseSchema },
      },
      validatorCompiler: compileClosedTypeBoxSchema,
    },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id } = request.params as { id: string };
      const body = request.body as { definitionVersion: number };
      const context = await requestDeps(request);
      const outcome = await syncTasks(db, context, {
        commandId,
        activityId: id,
        definitionVersion: body.definitionVersion,
        actor: context.actor ?? SYSTEM_ACTOR,
      });
      return reply.status(200).send(outcome.body);
    },
  );

  app.post(
    "/api/activities/:id/tasks/:taskId/assign",
    {
      schema: { params: TaskParamsSchema, body: AssignTaskBodySchema, response: { 200: TaskResponseSchema } },
      validatorCompiler: compileClosedTypeBoxSchema,
    },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id, taskId } = request.params as { id: string; taskId: string };
      const body = request.body as {
        expectedRevision: number;
        assigneeActorId: string | null;
        dueAt?: string | null;
      };
      const context = await requestDeps(request);
      const outcome = await assignTask(db, context, {
        commandId,
        activityId: id,
        taskId,
        expectedRevision: body.expectedRevision,
        assigneeActorId: body.assigneeActorId,
        ...(body.dueAt === undefined ? {} : { dueAt: body.dueAt }),
        actor: context.actor ?? SYSTEM_ACTOR,
      });
      return reply.status(200).send(outcome.body);
    },
  );

  app.post(
    "/api/activities/:id/tasks/:taskId/start",
    {
      schema: { params: TaskParamsSchema, body: TaskRevisionBodySchema, response: { 200: TaskResponseSchema } },
      validatorCompiler: compileClosedTypeBoxSchema,
    },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id, taskId } = request.params as { id: string; taskId: string };
      const body = request.body as { expectedRevision: number };
      const context = await requestDeps(request);
      const outcome = await startTask(db, context, {
        commandId, activityId: id, taskId, expectedRevision: body.expectedRevision,
        actor: context.actor ?? SYSTEM_ACTOR,
      });
      return reply.status(200).send(outcome.body);
    },
  );

  for (const [action, bodySchema] of [
    ["block", TaskReasonBodySchema],
    ["complete", TaskReasonBodySchema],
    ["reopen", TaskReasonBodySchema],
  ] as const) {
    app.post(
      `/api/activities/:id/tasks/:taskId/${action}`,
      {
        schema: { params: TaskParamsSchema, body: bodySchema, response: { 200: TaskResponseSchema } },
        validatorCompiler: compileClosedTypeBoxSchema,
      },
      async (request, reply) => {
        const commandId = requireIdempotency(request);
        const { id, taskId } = request.params as { id: string; taskId: string };
        const body = request.body as { expectedRevision: number; reason: string };
        const context = await requestDeps(request);
        const input = {
          commandId,
          activityId: id,
          taskId,
          expectedRevision: body.expectedRevision,
          reason: body.reason,
          actor: context.actor ?? SYSTEM_ACTOR,
        };
        const outcome = action === "block"
          ? await blockTask(db, context, input)
          : action === "complete"
            ? await completeTask(db, context, input)
            : await reopenTask(db, context, input);
        return reply.status(200).send(outcome.body);
      },
    );
  }

}
