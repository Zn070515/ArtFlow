import type { ApiContext } from "../http/context.js";
import { ArchiveActivityBodySchema, ArchiveFileQuerySchema, UnarchiveActivityBodySchema } from "@artflow-plus/contracts";
import { archiveActivity, getArchiveState, readArchiveFile, unarchiveActivity } from "@artflow-plus/runtime";
import { ActivityParams } from "../http/schemas.js";
import { requireIdempotency } from "../http/helpers.js";

export function registerArchiveRoutes(ctx: ApiContext): void {
  const {
    app, db, deps, baseDeps, registry, packs, rateLimiter, isProduction,
    sessionSecret, enableRuntimeFacts,
    setSessionCookies, clearSessionCookies, publicActor, requestSession,
    requestActor, requestDeps, requireStudio, requireOperationsReader,
    requireReadAccess, requireSessionManager, publicDeps, judgeScoreDeps,
    requireRateLimit, requirePublicRateLimit, routeRound,
  } = ctx;

  app.post(
    "/api/activities/:id/archive",
    { schema: { params: ActivityParams, body: ArchiveActivityBodySchema } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id } = request.params as { id: string };
      const body = request.body as { expectedRevision: number; note: string };
      const outcome = await archiveActivity(db, await requestDeps(request), {
        commandId,
        activityId: id,
        expectedRevision: body.expectedRevision,
        note: body.note,
      });
      return reply.status(outcome.status).send(outcome.body);
    },
  );

  app.post(
    "/api/activities/:id/unarchive",
    { schema: { params: ActivityParams, body: UnarchiveActivityBodySchema } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id } = request.params as { id: string };
      const body = request.body as { expectedRevision: number; note: string };
      const outcome = await unarchiveActivity(db, await requestDeps(request), {
        commandId,
        activityId: id,
        expectedRevision: body.expectedRevision,
        note: body.note,
      });
      return reply.status(outcome.status).send(outcome.body);
    },
  );

  app.get(
    "/api/activities/:id/archive",
    { schema: { params: ActivityParams }, config: { access: "archive" } },
    async (request) => {
      const { id } = request.params as { id: string };
      return getArchiveState(db, await requestDeps(request), { activityId: id });
    },
  );

  app.get(
    "/api/activities/:id/archive/file",
    { schema: { params: ActivityParams, querystring: ArchiveFileQuerySchema }, config: { access: "archive" } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const query = request.query as { version?: number };
      const file = await readArchiveFile(db, await requestDeps(request), {
        activityId: id,
        ...(query.version === undefined ? {} : { version: query.version }),
      });
      return reply
        .type("application/zip")
        .header("content-disposition", `attachment; filename="${file.filename}"`)
        .header("content-length", String(file.bytes.byteLength))
        .header("cache-control", "no-store")
        .send(Buffer.from(file.bytes));
    },
  );
}
