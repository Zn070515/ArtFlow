import type { ApiContext } from "../http/context.js";

function positiveLimit(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}
import { ClaimInviteBodySchema, InvitePreviewBodySchema, RegisterParticipantBodySchema } from "@artflow-plus/contracts";
import { getLocalAccountByActorId, revokeLocalSession } from "@artflow-plus/db";
import { DomainError } from "@artflow-plus/domain";
import {
  authenticateLocalAccount,
  beginMfaEnrollment,
  claimInvite,
  completeMfaLogin,
  confirmMfaEnrollment,
  csrfTokenFor,
  disableMfa,
  previewInvite,
  registerParticipantAccount,
  requestPasswordReset,
  resetPasswordWithToken,
  beginOidcLogin,
  completeOidcLogin,
  issueOidcSession,
  oidcConfigFromEnv,
  resolveOidcAccount,
} from "@artflow-plus/runtime";
import { Type } from "@sinclair/typebox";
import { LoginBody } from "../http/schemas.js";
import { sessionCookie } from "../cookies.js";
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
      if (result.kind === "mfa") {
        return reply.send({ mfaRequired: true, challenge: result.challenge });
      }
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
      if (result.kind === "mfa") {
        return { mfaRequired: true, challenge: result.challenge };
      }
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
      const body = request.body as { username: string; password: string; email?: string };
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

  app.post(
    "/api/auth/invite-preview",
    { schema: { body: InvitePreviewBodySchema } },
    async (request) => {
      await requirePublicRateLimit(request, "invite-preview", 20);
      const body = request.body as { token: string };
      return previewInvite(db, body.token);
    },
  );

  app.post(
    "/api/auth/claim-invite",
    { schema: { body: ClaimInviteBodySchema } },
    async (request, reply) => {
      await requirePublicRateLimit(request, "invite-claim", 5);
      const body = request.body as { token: string; password: string };
      const result = await claimInvite(db, body);
      const csrf = csrfTokenFor(result.token, sessionSecret);
      setSessionCookies(reply, result.token, csrf);
      return reply.status(201).send({
        actor: publicActor(result.actor),
        csrfToken: csrf,
        expiresAt: result.expiresAt,
      });
    },
  );

  app.post(
    "/api/auth/mfa",
    {
      schema: {
        body: Type.Object({
          challenge: Type.String({ minLength: 1, maxLength: 4096 }),
          code: Type.String({ minLength: 6, maxLength: 6 }),
        }, { additionalProperties: false }),
      },
    },
    async (request, reply) => {
      await requirePublicRateLimit(request, "auth-mfa", 10);
      const body = request.body as { challenge: string; code: string };
      const result = await completeMfaLogin(db, body);
      const csrf = csrfTokenFor(result.token, sessionSecret);
      setSessionCookies(reply, result.token, csrf);
      return {
        actor: publicActor(result.actor),
        csrfToken: csrf,
        expiresAt: result.expiresAt,
      };
    },
  );

  app.post(
    "/api/auth/mfa/enroll",
    {
      schema: {
        body: Type.Object({}, { additionalProperties: false }),
      },
    },
    async (request) => {
      const requestContext = await requestDeps(request);
      return await beginMfaEnrollment(db, requestContext.actor ?? (await requestActor(request)));
    },
  );

  app.post(
    "/api/auth/mfa/confirm",
    {
      schema: {
        body: Type.Object({ code: Type.String({ minLength: 6, maxLength: 6 }) }, { additionalProperties: false }),
      },
    },
    async (request) => {
      const body = request.body as { code: string };
      await confirmMfaEnrollment(db, await requestActor(request), body.code);
      return { ok: true };
    },
  );

  app.post(
    "/api/auth/mfa/disable",
    {
      schema: {
        body: Type.Object({
          password: Type.String({ minLength: 1, maxLength: 200 }),
          code: Type.String({ minLength: 6, maxLength: 6 }),
        }, { additionalProperties: false }),
      },
    },
    async (request) => {
      const body = request.body as { password: string; code: string };
      await disableMfa(db, await requestActor(request), body);
      return { ok: true };
    },
  );

  app.post(
    "/api/auth/password/forgot",
    {
      schema: {
        body: Type.Object({ identifier: Type.String({ minLength: 1, maxLength: 320 }) }, { additionalProperties: false }),
      },
    },
    async (request) => {
      await requirePublicRateLimit(request, "auth-forgot", 5);
      const body = request.body as { identifier: string };
      await requestPasswordReset(db, deps.mailer ?? null, {
        identifier: body.identifier,
        appBaseUrl: process.env.ARTFLOW_PLUS_APP_BASE_URL ?? "http://127.0.0.1:4173",
      });
      // Always the same answer: do not reveal whether the identifier exists.
      return { ok: true };
    },
  );

  app.post(
    "/api/auth/password/reset",
    {
      schema: {
        body: Type.Object({
          token: Type.String({ minLength: 1, maxLength: 512 }),
          password: Type.String({ minLength: 12, maxLength: 128 }),
        }, { additionalProperties: false }),
      },
    },
    async (request) => {
      await requirePublicRateLimit(request, "auth-reset", 5);
      const body = request.body as { token: string; password: string };
      await resetPasswordWithToken(db, body);
      return { ok: true };
    },
  );

  app.get("/api/auth/oidc/config", { config: { access: "public" } }, async () => {
    const config = oidcConfigFromEnv();
    return config === null
      ? { enabled: false }
      : { enabled: true, label: config.label };
  });

  app.get("/api/auth/oidc/start", { config: { access: "public" } }, async (_request, reply) => {
    const config = oidcConfigFromEnv();
    if (config === null) throw new DomainError("OIDC_UNAVAILABLE", "Single sign-on is not configured.");
    const start = await beginOidcLogin(config);
    reply.header(
      "set-cookie",
      sessionCookie("artflow_oidc", start.cookie, new Date(Date.now() + 10 * 60 * 1000).toISOString(), isProduction, {
        sameSite: "Lax",
      }),
    );
    return reply.redirect(start.authorizationUrl);
  });

  app.get("/api/auth/oidc/callback", { config: { access: "public" } }, async (request, reply) => {
    const config = oidcConfigFromEnv();
    if (config === null) throw new DomainError("OIDC_UNAVAILABLE", "Single sign-on is not configured.");
    const query = request.query as { code?: string; state?: string; error?: string };
    if (query.code === undefined || query.state === undefined || query.error !== undefined) {
      return reply.redirect("/login?oidc=denied");
    }
    try {
      const claims = await completeOidcLogin(config, {
        code: query.code,
        state: query.state,
        cookie: cookieValue(request, "artflow_oidc"),
      });
      const account = await resolveOidcAccount(db, config, claims);
      const result = await issueOidcSession(db, account.username);
      const csrf = csrfTokenFor(result.token, sessionSecret);
      reply.header("set-cookie", [
        sessionCookie("artflow_session", result.token, result.expiresAt, isProduction),
        sessionCookie("artflow_csrf", csrf, result.expiresAt, isProduction, { httpOnly: false }),
        sessionCookie("artflow_oidc", "", new Date(0).toISOString(), isProduction),
      ]);
      return reply.redirect("/me");
    } catch (error) {
      request.log.error(error as Error);
      return reply.redirect("/login?oidc=error");
    }
  });

  app.get("/api/auth/me", { config: { access: "public" } }, async (request) => {
    const session = await requestSession(request);
    if (session === null) throw new DomainError("UNAUTHENTICATED", "A valid session is required.");
    const account = await getLocalAccountByActorId(db, session.actor.actorId);
    return {
      actor: publicActor(session.actor),
      csrfToken: csrfTokenFor(session.token, sessionSecret),
      expiresAt: session.expiresAt,
      mfaEnabled: account?.mfaEnabled ?? false,
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
