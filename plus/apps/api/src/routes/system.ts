import type { ApiContext } from "../http/context.js";
import { PackInstantiateBodySchema, errorResponse } from "@artflow-plus/contracts";
import { checkReady } from "@artflow-plus/db";
import { DomainError, instantiateActivityPack } from "@artflow-plus/domain";
import { PackParams } from "../http/schemas.js";

export function registerSystemRoutes(ctx: ApiContext): void {
  const {
    app, db, deps, baseDeps, registry, packs, rateLimiter, isProduction,
    sessionSecret, enableRuntimeFacts,
    setSessionCookies, clearSessionCookies, publicActor, requestSession,
    requestActor, requestDeps, requireStudio, requireOperationsReader,
    requireReadAccess, requireSessionManager, publicDeps, judgeScoreDeps,
    requireRateLimit, requirePublicRateLimit, routeRound,
  } = ctx;

  app.get("/healthz", { config: { access: "public" } }, async () => ({ status: "ok" }));
  app.get("/readyz", { config: { access: "public" } }, async (_request, reply) => {
    try {
      await checkReady(db);
      return { status: "ok" };
    } catch {
      // The generic status deliberately does not leak the failure detail.
      return reply.status(503).send({ status: "unavailable" });
    }
  });
  app.get("/openapi.json", { schema: { hide: true }, config: { access: "public" } }, async () => app.swagger());

  app.get("/api/capabilities", { config: { access: "public" } }, async () => ({
    capabilities: registry.list().map((registration) => registration.manifest),
  }));

  app.get("/api/packs", { config: { access: "public" } }, async () => ({ packs }));

  app.post(
    "/api/packs/:id/instantiate",
    { schema: { params: PackParams, body: PackInstantiateBodySchema } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const pack = packs.find((candidate) => candidate.identity === id);
      if (pack === undefined) {
        throw new DomainError("NOT_FOUND", `Pack ${id} was not found.`);
      }
      const body = request.body as {
        title?: string;
        answers?: Record<string, boolean>;
        enable?: string[];
        disable?: string[];
      };
      const result = instantiateActivityPack(pack, registry, body);
      if (!result.ok) {
        return reply
          .status(422)
          .send(
            errorResponse(
              "PACK_COMPOSITION_INVALID",
              `Pack ${id} cannot be instantiated with the registered capabilities.`,
              result.issues,
            ),
          );
      }
      return reply.send(result.instantiation);
    },
  );
}
