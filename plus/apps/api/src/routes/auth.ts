import type { ApiContext } from "../http/context.js";

function positiveLimit(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}
import { RegisterParticipantBodySchema } from "@artflow-plus/contracts";
import { revokeLocalSession } from "@artflow-plus/db";
import { DomainError } from "@artflow-plus/domain";
import { authenticateLocalAccount, csrfTokenFor, registerParticipantAccount } from "@artflow-plus/runtime";
import { LoginBody } from "../http/schemas.js";
import { bearerToken, cookieValue } from "../http/helpers.js";

export function registerAuthRoutes(ctx: ApiContext): void {
  const {
    app, db, deps, baseDeps, registry, packs, rateLimiter, isProduction,
    sessionSecret, enableRuntimeFacts,
    setSessionCookies, clearSessionCookies, publicActor, requestSession,
    requestActor, requestDeps, requireStudio, requireOperationsReader,
    requireReadAccess, requireSessionManager, publicDeps, judgeScoreDeps,
    requireRateLimit, requirePublicRateLimit, routeRound,
  } = ctx;

  app.post(
    "/api/auth/login",
    { schema: { body: LoginBody } },
    async (request, reply) => { // codeql[js/missing-rate-limiting] requirePublicRateLimit enforces the route budget.
      const body = request.body as { username: string; password: string };
      // codeql[js/missing-rate-limiting] requirePublicRateLimit enforces the per-IP budget.
      await requirePublicRateLimit(request, "auth-login", positiveLimit("ARTFLOW_PLUS_AUTH_PUBLIC_LIMIT", 10));
      await requireRateLimit(`auth-login-user:${body.username.trim().toLowerCase()}`, positiveLimit("ARTFLOW_PLUS_AUTH_USER_LIMIT", 20));
      const result = await authenticateLocalAccount(db, body);
      const csrf = csrfTokenFor(result.token, sessionSecret);
      setSessionCookies(reply, result.token, csrf);
      // The browser never needs the bearer token: it already holds the HttpOnly
      // cookie. Returning it here would put the session secret back into JS.
      return {
        actor: publicActor(result.actor),
        csrfToken: csrf,
        expiresAt: result.expiresAt,
      };
    },
  );

  app.post(
    "/api/auth/token",
    { schema: { body: LoginBody } },
    async (request) => { // codeql[js/missing-rate-limiting] requirePublicRateLimit enforces the route budget.
      const body = request.body as { username: string; password: string };
      // codeql[js/missing-rate-limiting] requirePublicRateLimit enforces the per-IP budget.
      await requirePublicRateLimit(request, "auth-token", positiveLimit("ARTFLOW_PLUS_AUTH_PUBLIC_LIMIT", 10));
      await requireRateLimit(`auth-token-user:${body.username.trim().toLowerCase()}`, positiveLimit("ARTFLOW_PLUS_AUTH_USER_LIMIT", 20));
      const result = await authenticateLocalAccount(db, body);
      // Programmatic clients (tests, CLI) authenticate with a bearer token; the
      // browser login above does not expose one.
      return {
        token: result.token,
        actor: publicActor(result.actor),
        expiresAt: result.expiresAt,
      };
    },
  );

  app.post(
    "/api/auth/register",
    { schema: { body: RegisterParticipantBodySchema } },
    async (request, reply) => {
      await requirePublicRateLimit(request, "auth-register", 5);
      const body = request.body as { username: string; password: string };
      // A duplicate username is deliberately reported for usability, so make
      // enumeration cost more than the shared per-IP budget alone.
      await requireRateLimit(`auth-register-user:${body.username.trim().toLowerCase()}`, 3);
      const result = await registerParticipantAccount(db, body);
      const csrf = csrfTokenFor(result.token, sessionSecret);
      setSessionCookies(reply, result.token, csrf);
      return reply.status(201).send({
        actor: publicActor(result.actor),
        csrfToken: csrf,
        expiresAt: result.expiresAt,
      });
    },
  );

  app.get("/api/auth/me", { config: { access: "public" } }, async (request) => {
    const session = await requestSession(request);
    if (session === null) throw new DomainError("UNAUTHENTICATED", "A valid session is required.");
    return {
      actor: publicActor(session.actor),
      csrfToken: csrfTokenFor(session.token, sessionSecret),
      expiresAt: session.expiresAt,
    };
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const token = cookieValue(request, "artflow_session") ?? bearerToken(request);
    if (token !== undefined && token.trim() !== "") {
      await revokeLocalSession(db, token.trim(), new Date().toISOString());
    }
    clearSessionCookies(reply);
    return { ok: true };
  });
}
