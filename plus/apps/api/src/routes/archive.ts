import type { ApiContext } from "../http/context.js";
import { ArchiveActivityBodySchema, ArchiveFileQuerySchema, UnarchiveActivityBodySchema } from "@artflow-plus/contracts";
import { archiveActivity, getArchiveState, readArchiveFile, unarchiveActivity } from "@artflow-plus/runtime";
import { ActivityParams } from "../http/schemas.js";
import { requireIdempotency } from "../http/helpers.js";
import { parseRange } from "../http/range.js";

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
      // The size must be known before the range decision; a stat is cheap and
      // the integrity check only runs once per download.
      const probe = await readArchiveFile(db, await requestDeps(request), {
        activityId: id,
        ...(query.version === undefined ? {} : { version: query.version }),
      });
      const range = parseRange(request.headers.range, probe.size);
      if (range === "invalid") {
        probe.stream.destroy();
        return reply.code(416).header("content-range", `bytes */${probe.size}`).send();
      }
      // Without a Range header the probe stream is the response. With one, the
      // probe's descriptor is closed before a second, partial stream is opened.
      const file = range === null
        ? probe
        : await (async () => {
            probe.stream.destroy();
            return await readArchiveFile(db, await requestDeps(request), {
              activityId: id,
              ...(query.version === undefined ? {} : { version: query.version }),
              range,
            });
          })();
      reply
        .type("application/zip")
        .header("content-disposition", `attachment; filename="${file.filename}"`)
        .header("accept-ranges", "bytes")
        .header("cache-control", "no-store");
      if (range === null) {
        return reply.header("content-length", String(file.size)).send(file.stream);
      }
      return reply
        .code(206)
        .header("content-range", `bytes ${range.start}-${range.end}/${file.size}`)
        .header("content-length", String(range.end - range.start + 1))
        .send(file.stream);
    },
  );
}
