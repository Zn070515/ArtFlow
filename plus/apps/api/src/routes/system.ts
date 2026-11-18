import type { ApiContext } from "../http/context.js";
import { PackInstantiateBodySchema, errorResponse } from "@artflow-plus/contracts";
import { checkReady } from "@artflow-plus/db";
import { DomainError, instantiateActivityPack } from "@artflow-plus/domain";
import { timingSafeEqual } from "node:crypto";
import { PackParams } from "../http/schemas.js";

export function registerSystemRoutes(ctx: ApiContext): void {
  const {
    app, db, deps, baseDeps, registry, packs, rateLimiter, metrics, isProduction,
    sessionSecret, enableRuntimeFacts,
    setSessionCookies, clearSessionCookies, publicActor, requestSession,
    requestActor, requestDeps, requireStudio, requireOperationsReader,
    requireReadAccess, requireSessionManager, publicDeps, judgeScoreDeps,
    requireRateLimit, requirePublicRateLimit, routeRound,
  } = ctx;

  app.get("/metrics", { schema: { hide: true }, config: { access: "public" } }, async (request, reply) => {
    const expected = process.env.ARTFLOW_PLUS_METRICS_TOKEN;
    if (expected === undefined || expected.trim() === "") {
      // Disabled by default; a deployment opts in with a secret.
      return reply.status(404).send();
    }
    const raw = request.headers["x-artflow-metrics-token"];
    const provided = Array.isArray(raw) ? raw[0] : raw;
    const left = Buffer.from(provided ?? "");
    const right = Buffer.from(expected);
    if (left.length !== right.length || !timingSafeEqual(left, right)) {
      // Do not reveal that the endpoint exists to an unauthenticated caller.
      return reply.status(404).send();
    }
    reply.type("text/plain; version=0.0.4; charset=utf-8");
    return metrics.render();
  });
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
  // The schema enumerates every command and read surface. It is an operator
  // tool, not public event content, so it follows the operations read level.
  app.get("/openapi.json", { schema: { hide: true }, config: { access: "operations" } }, async () => app.swagger());

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
