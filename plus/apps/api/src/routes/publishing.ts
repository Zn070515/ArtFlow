import type { ApiContext } from "../http/context.js";
import { ConfirmStageResultBodySchema, EditPublicationBodySchema, PublishingReleaseParamsSchema, PublishingStageParamsSchema, ReleaseResultBodySchema, RevokeResultReleaseBodySchema, UnlockStageResultBodySchema } from "@artflow-plus/contracts";
import { confirmStageResult, confirmVoteStageResult, editPublication, getPublishingState, getVoteResultCandidate, releaseResult, revokeResultRelease, unlockStageResult } from "@artflow-plus/runtime";
import { ActivityParams, ConfirmVoteResultBodySchema, VoteResultParamsSchema } from "../http/schemas.js";
import { requireIdempotency } from "../http/helpers.js";

export function registerPublishingRoutes(ctx: ApiContext): void {
  const {
    app, db, deps, baseDeps, registry, packs, rateLimiter, isProduction,
    sessionSecret, enableRuntimeFacts,
    setSessionCookies, clearSessionCookies, publicActor, requestSession,
    requestActor, requestDeps, requireStudio, requireOperationsReader,
    requireReadAccess, requireSessionManager, publicDeps, judgeScoreDeps,
    requireRateLimit, requirePublicRateLimit, routeRound,
  } = ctx;

  app.post(
    "/api/activities/:id/publishing/stage-results/:stageKey/confirm",
    { schema: { params: PublishingStageParamsSchema, body: ConfirmStageResultBodySchema } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id, stageKey } = request.params as { id: string; stageKey: string };
      const body = request.body as {
        scope: string;
        expectedSourceRevision: number;
        expectedInputFingerprint: string;
        awards: { award: string; contestantId: string }[];
        note?: string;
      };
      const outcome = await confirmStageResult(db, await requestDeps(request), {
        commandId,
        activityId: id,
        stageKey,
        scope: body.scope,
        expectedSourceRevision: body.expectedSourceRevision,
        expectedInputFingerprint: body.expectedInputFingerprint,
        awards: body.awards,
        ...(body.note === undefined ? {} : { note: body.note }),
      });
      return reply.status(outcome.status).send(outcome.body);
    },
  );

  app.get(
    "/api/activities/:id/publishing/vote-results/:sessionId",
    { schema: { params: VoteResultParamsSchema }, config: { access: "result" } },
    async (request) => {
      const { id, sessionId } = request.params as { id: string; sessionId: string };
      return getVoteResultCandidate(db, await requestDeps(request), {
        activityId: id,
        sessionId,
      });
    },
  );

  app.post(
    "/api/activities/:id/publishing/stage-results/:stageKey/confirm-vote",
    { schema: { params: PublishingStageParamsSchema, body: ConfirmVoteResultBodySchema } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id, stageKey } = request.params as { id: string; stageKey: string };
      const body = request.body as {
        scope: string;
        voteSessionId: string;
        expectedSessionRevision: number;
        expectedInputFingerprint: string;
        awards: { award: string; contestantId: string }[];
        note?: string;
      };
      const outcome = await confirmVoteStageResult(db, await requestDeps(request), {
        commandId,
        activityId: id,
        stageKey,
        scope: body.scope,
        voteSessionId: body.voteSessionId,
        expectedSessionRevision: body.expectedSessionRevision,
        expectedInputFingerprint: body.expectedInputFingerprint,
        awards: body.awards,
        ...(body.note === undefined ? {} : { note: body.note }),
      });
      return reply.status(outcome.status).send(outcome.body);
    },
  );

  app.post(
    "/api/activities/:id/publishing/stage-results/:stageKey/unlock",
    { schema: { params: PublishingStageParamsSchema, body: UnlockStageResultBodySchema } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id, stageKey } = request.params as { id: string; stageKey: string };
      const body = request.body as { scope: string; expectedCandidateRevision: number; note: string };
      const outcome = await unlockStageResult(db, await requestDeps(request), {
        commandId,
        activityId: id,
        stageKey,
        scope: body.scope,
        expectedCandidateRevision: body.expectedCandidateRevision,
        note: body.note,
      });
      return reply.status(outcome.status).send(outcome.body);
    },
  );

  app.post(
    "/api/activities/:id/publishing/releases",
    { schema: { params: ActivityParams, body: ReleaseResultBodySchema } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id } = request.params as { id: string };
      const body = request.body as {
        stageKey: string;
        scope: string;
        expectedCandidateRevision: number;
        note: string;
      };
      const outcome = await releaseResult(db, await requestDeps(request), {
        commandId,
        activityId: id,
        stageKey: body.stageKey,
        scope: body.scope,
        expectedCandidateRevision: body.expectedCandidateRevision,
        note: body.note,
      });
      return reply.status(outcome.status).send(outcome.body);
    },
  );

  app.post(
    "/api/activities/:id/publishing/releases/:releaseId/revoke",
    { schema: { params: PublishingReleaseParamsSchema, body: RevokeResultReleaseBodySchema } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id, releaseId } = request.params as { id: string; releaseId: string };
      const body = request.body as { scope: string; note: string };
      const outcome = await revokeResultRelease(db, await requestDeps(request), {
        commandId,
        activityId: id,
        releaseId,
        scope: body.scope,
        note: body.note,
      });
      return reply.status(outcome.status).send(outcome.body);
    },
  );

  app.patch(
    "/api/activities/:id/publishing/publications/:stageKey",
    { schema: { params: PublishingStageParamsSchema, body: EditPublicationBodySchema } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id, stageKey } = request.params as { id: string; stageKey: string };
      const body = request.body as {
        scope: string;
        expectedVersion: number;
        title: string;
        content: string;
      };
      const outcome = await editPublication(db, await requestDeps(request), {
        commandId,
        activityId: id,
        stageKey,
        scope: body.scope,
        expectedVersion: body.expectedVersion,
        title: body.title,
        content: body.content,
      });
      return reply.status(outcome.status).send(outcome.body);
    },
  );

  app.get(
    "/api/activities/:id/publishing/state",
    { schema: { params: ActivityParams }, config: { access: "result" } },
    async (request) => {
      const { id } = request.params as { id: string };
      return getPublishingState(db, await requestDeps(request), { activityId: id });
    },
  );
}
