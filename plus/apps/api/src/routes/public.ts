import type { ApiContext } from "../http/context.js";
import { sessionCookie } from "../cookies.js";
import { JudgeEntryBodySchema, PublicResultsParamsSchema, PublicResultsQuerySchema } from "@artflow-plus/contracts";
import { selectPublicResults } from "@artflow-plus/db";
import { DomainError } from "@artflow-plus/domain";
import { authenticateTicketSession, claimJudgeSeat, getJudgeContext, getLiveState as getLiveActivityState, getPublicActivity, getPublicProgram, getSupplementContext, readPublicVoteSession, submitSupplement, uploadSupplementMaterial } from "@artflow-plus/runtime";
import { Type } from "@sinclair/typebox";
import { ActivityParams, PublicActivityParams, PublicVoteParams } from "../http/schemas.js";
import { cookieValue, requireIdempotency, sessionTokenValue, setSessionCookie } from "../http/helpers.js";

export function registerPublicRoutes(ctx: ApiContext): void {
  const {
    app, db, deps, baseDeps, registry, packs, rateLimiter, isProduction,
    sessionSecret, enableRuntimeFacts,
    setSessionCookies, clearSessionCookies, publicActor, requestSession,
    requestActor, requestDeps, requireStudio, requireOperationsReader,
    requireReadAccess, requireSessionManager, publicDeps, judgeScoreDeps,
    requireRateLimit, requirePublicRateLimit, routeRound,
  } = ctx;

  app.get(
    "/api/public/activities/:publicCode",
    { schema: { params: PublicActivityParams }, config: { access: "public" } },
    async (request, reply) => {
      const { publicCode } = request.params as { publicCode: string };
      const activity = await getPublicActivity(db, publicCode);
      if (activity === null) {
        throw new DomainError("NOT_FOUND", "The activity was not found.");
      }
      reply.header("cache-control", "no-store");
      return activity;
    },
  );

  app.get(
    "/api/public/vote/:sessionId",
    { schema: { params: PublicVoteParams }, config: { access: "public" } },
    async (request, reply) => { // codeql[js/missing-rate-limiting] requirePublicRateLimit enforces the route budget.
      const { sessionId } = request.params as { sessionId: string };
      await requirePublicRateLimit(request, `public-vote:${sessionId}`, 120);
      let ticketIdentity: { readonly activityId: string; readonly ticketId: string } | undefined;
      const ticketSessionToken = cookieValue(request, "artflow_ticket_session");
      if (ticketSessionToken !== undefined) {
        try {
          ticketIdentity = await authenticateTicketSession(
            db,
            ticketSessionToken,
            new Date(deps.now()),
          );
        } catch {
          ticketIdentity = undefined;
        }
      }
      const session = await readPublicVoteSession(
        db,
        sessionId,
        cookieValue(request, "artflow_browser_id"),
        ticketIdentity,
      );
      if (session === null) throw new DomainError("NOT_FOUND", "Voting session not found.");
      reply.header("cache-control", "no-store");
      return session;
    },
  );

  app.post(
    "/api/public/supplement/claim",
    { schema: { body: Type.Object({ token: Type.String({ minLength: 1 }) }, { additionalProperties: false }) }, config: { access: "public" } },
    async (request, reply) => {
      await requirePublicRateLimit(request, "supplement-claim", 20);
      const body = request.body as { token: string };
      const context = await getSupplementContext(db, body.token, deps.now());
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      reply.header(
        "set-cookie",
        sessionCookie("artflow_supplement", body.token, expiresAt, isProduction),
      );
      reply.header("cache-control", "no-store");
      return context;
    },
  );

  app.get(
    "/api/public/supplement/context",
    { config: { access: "public" } },
    async (request, reply) => {
      await requirePublicRateLimit(request, "supplement-context", 60);
      const token = cookieValue(request, "artflow_supplement");
      if (token === undefined) throw new DomainError("INVALID_SUPPLEMENT", "A supplement capability is required.");
      reply.header("cache-control", "no-store");
      return getSupplementContext(db, token, deps.now());
    },
  );

  app.put(
    "/api/public/supplement/materials/:questionKey/content",
    { schema: { params: Type.Object({ questionKey: Type.String({ minLength: 1, maxLength: 100 }) }, { additionalProperties: false }) } },
    async (request, reply) => {
      await requirePublicRateLimit(request, "supplement-upload", 20);
      const token = cookieValue(request, "artflow_supplement");
      if (token === undefined) throw new DomainError("INVALID_SUPPLEMENT", "A supplement capability is required.");
      const { questionKey } = request.params as { questionKey: string };
      const body = request.body;
      if (!Buffer.isBuffer(body)) {
        throw new DomainError("INVALID_INPUT", "Material content must be sent as application/octet-stream.");
      }
      const query = request.query as { name?: string; type?: string };
      const outcome = await uploadSupplementMaterial(db, deps, {
        token,
        commandId: requireIdempotency(request),
        questionKey,
        originalName: query.name ?? questionKey,
        contentType: query.type ?? "application/octet-stream",
        bytes: body,
      });
      return reply.status(201).send(outcome);
    },
  );

  app.post(
    "/api/public/supplement/submit",
    { config: { access: "public" } },
    async (request, reply) => {
      await requirePublicRateLimit(request, "supplement-submit", 10);
      const token = cookieValue(request, "artflow_supplement");
      if (token === undefined) throw new DomainError("INVALID_SUPPLEMENT", "A supplement capability is required.");
      const outcome = await submitSupplement(db, deps, {
        token,
        commandId: requireIdempotency(request),
      });
      return reply.status(outcome.status).send(outcome.body);
    },
  );

  app.get(
    "/api/activities/:id/live",
    { schema: { params: ActivityParams }, config: { access: "session" } },
    async (request) => {
      const { id } = request.params as { id: string };
      return getLiveActivityState(db, await requestDeps(request), id);
    },
  );

  app.get("/api/judge/context", { config: { access: "public" } }, async (request, reply) => {
    const token = cookieValue(request, "artflow_judge_session");
    if (token === undefined) throw new DomainError("UNAUTHENTICATED", "A judge session is required.");
    await requirePublicRateLimit(request, "judge-context", 120);
    reply.header("cache-control", "no-store");
    return getJudgeContext(db, token);
  });

  app.get(
    "/api/public/results/:publicCode",
    { schema: { params: PublicResultsParamsSchema, querystring: PublicResultsQuerySchema }, config: { access: "public" } },
    async (request, reply) => {
      const { publicCode } = request.params as { publicCode: string };
      const query = request.query as { stage?: string };
      await requirePublicRateLimit(request, `public-results:${publicCode}`, 120);
      const results = await selectPublicResults(db, publicCode, query.stage);
      reply.header("cache-control", "no-store");
      if (results === null) {
        return reply.status(404).send({ code: "NOT_FOUND", message: "The public results were not found." });
      }
      return results;
    },
  );

  app.get(
    "/api/public/programs/:publicCode",
    { schema: { params: PublicActivityParams }, config: { access: "public" } },
    async (request, reply) => {
      const { publicCode } = request.params as { publicCode: string };
      await requirePublicRateLimit(request, `public-program:${publicCode}`, 120);
      const program = await getPublicProgram(db, publicCode);
      reply.header("cache-control", "no-store");
      if (program === null) {
        return reply.status(404).send({ code: "NOT_FOUND", message: "The program was not found." });
      }
      return program;
    },
  );

  app.post(
    "/api/judge-entry/claim",
    { schema: { body: JudgeEntryBodySchema } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const body = request.body as { publicCode: string; capability: string | null };
      await requirePublicRateLimit(request, "judge-entry", 20);
      const outcome = await claimJudgeSeat(db, publicDeps(), { commandId, publicCode: body.publicCode, capability: body.capability ?? "" });
      reply.header("cache-control", "no-store");
      const judgeToken = sessionTokenValue(outcome.body.sessionToken);
      if (judgeToken !== undefined) {
        setSessionCookie(reply, "artflow_judge_session", judgeToken, outcome.body.expiresAt);
      }
      return reply.status(outcome.status).send({ ...outcome.body, sessionToken: null });
    },
  );
}
