import type { ApiContext } from "../http/context.js";
import { CloseVoteSessionBodySchema, OpenVoteSessionBodySchema, ReasonBodySchema, SubmitBallotBodySchema, TicketCredentialBodySchema } from "@artflow-plus/contracts";
import { getLiveState, getVoteSession, listTicketAccessSessionsForActivity, listTicketsForActivity } from "@artflow-plus/db";
import { DomainError, SYSTEM_ACTOR, requirePermission } from "@artflow-plus/domain";
import { closeVoteSession, getActivity, getClosedVoteScores, issueTicket, openVoteSession, readVotingSessionsState, redeemTicketCredential, revokeTicket, revokeTicketAccessSession, rotateTicketCredential, submitBallot } from "@artflow-plus/runtime";
import { randomBytes } from "node:crypto";
import { ActivityParams, SessionParams, TicketParams, TicketSessionParams } from "../http/schemas.js";
import { cookieValue, requireIdempotency, sessionTokenValue, setSessionCookie } from "../http/helpers.js";

export function registerVotingRoutes(ctx: ApiContext): void {
  const {
    app, db, deps, baseDeps, registry, packs, rateLimiter, isProduction,
    sessionSecret, enableRuntimeFacts,
    setSessionCookies, clearSessionCookies, publicActor, requestSession,
    requestActor, requestDeps, requireStudio, requireOperationsReader,
    requireReadAccess, requireSessionManager, publicDeps, judgeScoreDeps,
    requireRateLimit, requirePublicRateLimit, routeRound,
  } = ctx;

  app.post(
    "/api/activities/:id/voting/sessions",
    { schema: { params: ActivityParams, body: OpenVoteSessionBodySchema } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id } = request.params as { id: string };
      const body = request.body as { sessionId: string; scope: string; candidateIds: string[] };
      const outcome = await openVoteSession(db, await requestDeps(request), {
        commandId,
        activityId: id,
        sessionId: body.sessionId,
        scope: body.scope,
        candidateIds: body.candidateIds,
      });
      return reply.status(outcome.status).send(outcome.body);
    },
  );

  app.get(
    "/api/activities/:id/voting/sessions",
    { schema: { params: ActivityParams }, config: { access: "voting" } },
    async (request) => {
      const { id } = request.params as { id: string };
      const context = await requestDeps(request);
      requirePermission(context.actor ?? SYSTEM_ACTOR, "voting.manage");
      const state = await readVotingSessionsState(db, id);
      if (state === null) throw new DomainError("NOT_FOUND", `Activity ${id} was not found.`);
      return state;
    },
  );

  app.get(
    "/api/activities/:id/voting/browser-identity",
    { schema: { params: ActivityParams }, config: { access: "public" } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      await requirePublicRateLimit(request, `browser-identity:${id}`, 10);
      const activity = await getActivity(db, id);
      if (activity === null) throw new DomainError("NOT_FOUND", "The activity was not found.");
      const existing = cookieValue(request, "artflow_browser_id");
      if (existing !== undefined && existing.length >= 32) {
        reply.header("cache-control", "no-store");
        return { ready: true };
      }
      const browserId = randomBytes(32).toString("base64url");
      reply.header("set-cookie", `artflow_browser_id=${browserId}; Path=/; HttpOnly; SameSite=Lax`);
      reply.header("cache-control", "no-store");
      return { ready: true };
    },
  );

  app.post(
    "/api/activities/:id/voting/sessions/:sessionId/ballots",
    { schema: { params: SessionParams, body: SubmitBallotBodySchema } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id, sessionId } = request.params as { id: string; sessionId: string };
      const body = request.body as {
        scope: string;
        optionIds: string[];
        identity:
          | { type: "ticket" }
          | { type: "browser" }
          | { type: "anonymous" };
      };
      await requirePublicRateLimit(request, `ballot:${id}:${sessionId}`, 30);
      const identity = body.identity.type === "ticket"
        ? { type: "ticket" as const, sessionToken: cookieValue(request, "artflow_ticket_session") ?? "" }
        : body.identity.type === "browser"
        ? (() => {
            const fingerprint = cookieValue(request, "artflow_browser_id");
            if (fingerprint === undefined || fingerprint.length < 32) {
              throw new DomainError("BALLOT_IDENTITY_INVALID", "A browser identity cookie is required.");
            }
            return { type: "browser" as const, fingerprint };
          })()
        : body.identity;
      const outcome = await submitBallot(db, publicDeps(), {
        commandId,
        activityId: id,
        sessionId,
        scope: body.scope,
        optionIds: body.optionIds,
        identity,
      });
      reply.header("cache-control", "no-store");
      return reply.status(outcome.status).send(outcome.body);
    },
  );

  app.post(
    "/api/activities/:id/voting/sessions/:sessionId/close",
    { schema: { params: SessionParams, body: CloseVoteSessionBodySchema } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id, sessionId } = request.params as { id: string; sessionId: string };
      const body = request.body as { scope: string; expectedRevision: number };
      const outcome = await closeVoteSession(db, await requestDeps(request), {
        commandId,
        activityId: id,
        sessionId,
        scope: body.scope,
        expectedRevision: body.expectedRevision,
      });
      return reply.status(outcome.status).send(outcome.body);
    },
  );

  app.get(
    "/api/activities/:id/voting/sessions/:sessionId/scores",
    { schema: { params: SessionParams }, config: { access: "voting" } },
    async (request, reply) => {
      const { id, sessionId } = request.params as { id: string; sessionId: string };
      const session = await getVoteSession(db, sessionId);
      if (session === null || session.activityId !== id) throw new DomainError("NOT_FOUND", "The voting session was not found.");
      reply.header("cache-control", "no-store");
      return getClosedVoteScores(db, sessionId);
    },
  );

  app.get(
    "/api/activities/:id/voting/sessions/:sessionId/live",
    { schema: { params: SessionParams }, config: { access: "voting" } },
    async (request) => {
      const { id, sessionId } = request.params as { id: string; sessionId: string };
      const session = await getVoteSession(db, sessionId);
      if (session === null || session.activityId !== id) throw new DomainError("NOT_FOUND", "The voting session was not found.");
      return (await getLiveState(db, id, "vote_session", sessionId)) ?? {
        activityId: id,
        aggregateType: "vote_session",
        aggregateId: sessionId,
        lastSequence: 0,
        state: null,
        status: "running",
        stale: true,
      };
    },
  );

  app.get(
    "/api/activities/:id/ticketing/state",
    { schema: { params: ActivityParams }, config: { access: "session" } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const context = await requestDeps(request);
      requirePermission(context.actor ?? SYSTEM_ACTOR, "ticket.manage");
      const [tickets, sessions] = await Promise.all([
        listTicketsForActivity(db, id),
        listTicketAccessSessionsForActivity(db, id),
      ]);
      reply.header("cache-control", "no-store");
      return {
        tickets: tickets.map((ticket) => ({
          id: ticket.id,
          publicCode: ticket.publicCode,
          state: ticket.state,
          credentialVersion: ticket.credentialVersion,
          issuedAt: ticket.issuedAt,
          ...(ticket.redeemedAt === undefined ? {} : { redeemedAt: ticket.redeemedAt }),
          ...(ticket.revokedAt === undefined ? {} : { revokedAt: ticket.revokedAt }),
        })),
        sessions,
      };
    },
  );

  app.post(
    "/api/activities/:id/tickets",
    { schema: { params: ActivityParams } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id } = request.params as { id: string };
      const outcome = await issueTicket(db, await requestDeps(request), { commandId, activityId: id });
      reply.header("cache-control", "no-store");
      return reply.status(outcome.status).send(outcome.body);
    },
  );

  app.post(
    "/api/activities/:id/tickets/:ticketId/rotate",
    { schema: { params: TicketParams } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id, ticketId } = request.params as { id: string; ticketId: string };
      const outcome = await rotateTicketCredential(db, await requestDeps(request), { commandId, activityId: id, ticketId });
      reply.header("cache-control", "no-store");
      return reply.status(outcome.status).send(outcome.body);
    },
  );

  app.post(
    "/api/activities/:id/tickets/:ticketId/revoke",
    { schema: { params: TicketParams, body: ReasonBodySchema } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id, ticketId } = request.params as { id: string; ticketId: string };
      const body = request.body as { reason: string };
      const outcome = await revokeTicket(db, await requestDeps(request), { commandId, activityId: id, ticketId, reason: body.reason });
      return reply.status(outcome.status).send(outcome.body);
    },
  );

  app.post(
    "/api/activities/:id/ticket-sessions/:sessionId/revoke",
    { schema: { params: TicketSessionParams, body: ReasonBodySchema } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id, sessionId } = request.params as { id: string; sessionId: string };
      const body = request.body as { reason: string };
      const outcome = await revokeTicketAccessSession(db, await requestDeps(request), { commandId, activityId: id, sessionId, reason: body.reason });
      return reply.status(outcome.status).send(outcome.body);
    },
  );

  app.post(
    "/api/tickets/redeem",
    { schema: { body: TicketCredentialBodySchema } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const body = request.body as { credential: string };
      await requirePublicRateLimit(request, "ticket-redeem", 20);
      const outcome = await redeemTicketCredential(db, publicDeps(), { commandId, credential: body.credential });
      reply.header("cache-control", "no-store");
      const accessToken = sessionTokenValue(outcome.body.accessToken);
      if (accessToken !== undefined) {
        setSessionCookie(reply, "artflow_ticket_session", accessToken, outcome.body.expiresAt);
      }
      return reply.status(outcome.status).send({ ...outcome.body, accessToken: null });
    },
  );
}
