import type { ApiContext } from "../http/context.js";
import { ActivateCompetitionPanelBodySchema, AdvanceCompetitionPerformanceBodySchema, CompetitionRankingQuerySchema, CompetitionRoundParamsSchema, CompetitionRoundScoresQuerySchema, CompetitionRoundScoresResponseSchema, CompetitionScopeBodySchema, CompetitionScoreBodySchema, EditCompetitionScoreBodySchema, FinalizeAdvancementBodySchema, LockCompetitionRoundBodySchema, OpenCompetitionPerformanceBodySchema, OpenScoreCorrectionBodySchema, PrepareCompetitionRoundBodySchema, ReasonBodySchema, RecomputePodiumBodySchema, ReopenCompetitionRoundBodySchema, ResetRehearsalBodySchema, ResolveCompetitionBodySchema, ScoreCorrectionLifecycleBodySchema, TieDecisionBodySchema } from "@artflow-plus/contracts";
import { getCurrentRankingSnapshot } from "@artflow-plus/db";
import { DomainError } from "@artflow-plus/domain";
import { activateCompetitionPanel, advancePerformance, closeJudgeEntry, closeScoreCorrection, editScoreFact, finalizeAdvancement, getRoundScores, lockPerformance, lockRound, openPerformance, openScoreCorrection, prepareCompetitionRound, recalculateAfterCorrection, recomputePodiumCandidate, recordTieDecision, reissueJudgeCapability, reopenRoundForCorrection, resetRehearsalRound, resolveRound, submitJudgeScore, submitPaperScore, submitProxyScore, submitRapidScore } from "@artflow-plus/runtime";
import { Type } from "@sinclair/typebox";
import { ActivityParams, PrepareRoundBody, RoundParams } from "../http/schemas.js";
import { cookieValue, requireIdempotency } from "../http/helpers.js";

export function registerCompetitionRoutes(ctx: ApiContext): void {
  const {
    app, db, deps, baseDeps, registry, packs, rateLimiter, isProduction,
    sessionSecret, enableRuntimeFacts,
    setSessionCookies, clearSessionCookies, publicActor, requestSession,
    requestActor, requestDeps, requireStudio, requireOperationsReader,
    requireReadAccess, requireSessionManager, publicDeps, judgeScoreDeps,
    requireRateLimit, requirePublicRateLimit, routeRound,
  } = ctx;

  app.post(
    "/api/activities/:id/rounds/:roundKey/prepare",
    { schema: { params: RoundParams, body: PrepareRoundBody } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id, roundKey } = request.params as { id: string; roundKey: string };
      const body = request.body as { scope: string };
      const outcome = await prepareCompetitionRound(db, await requestDeps(request), {
        commandId,
        activityId: id,
        roundKey,
        scope: body.scope,
      });
      return reply.status(outcome.status).send(outcome.body);
    },
  );

  app.post(
    "/api/activities/:id/competition/rounds/:roundKey/prepare",
    { schema: { params: RoundParams, body: PrepareRoundBody } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id, roundKey } = request.params as { id: string; roundKey: string };
      const body = request.body as { scope: string };
      const outcome = await prepareCompetitionRound(db, await requestDeps(request), {
        commandId,
        activityId: id,
        roundKey,
        scope: body.scope,
      });
      return reply.status(outcome.status).send(outcome.body);
    },
  );

  app.post(
    "/api/activities/:id/competition/rounds",
    { schema: { params: ActivityParams, body: PrepareCompetitionRoundBodySchema } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id } = request.params as { id: string };
      const body = request.body as { roundKey: string; scope: string };
      const outcome = await prepareCompetitionRound(db, await requestDeps(request), {
        commandId,
        activityId: id,
        roundKey: body.roundKey,
        scope: body.scope,
      });
      return reply.status(outcome.status).send(outcome.body);
    },
  );

  app.post(
    "/api/activities/:id/competition/rounds/:roundKey/panel",
    { schema: { params: CompetitionRoundParamsSchema, body: ActivateCompetitionPanelBodySchema } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id, roundKey } = request.params as { id: string; roundKey: string };
      const body = request.body as { scope: string; judges: { judgeId: string; seatKey: string }[] };
      const round = await routeRound(id, roundKey);
      const outcome = await activateCompetitionPanel(db, await requestDeps(request), {
        commandId,
        activityId: id,
        roundId: round.id,
        scope: body.scope,
        judges: body.judges,
      });
      return reply.status(outcome.status).send(outcome.body);
    },
  );

  const CompetitionPerformanceParams = Type.Object({
    id: Type.String({ minLength: 1 }),
    roundKey: Type.String({ minLength: 1, maxLength: 100 }),
    performanceId: Type.String({ minLength: 1, maxLength: 100 }),
  }, { additionalProperties: false });

  app.post(
    "/api/activities/:id/competition/rounds/:roundKey/performances/:performanceId/open",
    { schema: { params: CompetitionPerformanceParams, body: OpenCompetitionPerformanceBodySchema } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id, roundKey, performanceId } = request.params as { id: string; roundKey: string; performanceId: string };
      const body = request.body as { scope: string; contestantId: string; sequence: number };
      const round = await routeRound(id, roundKey);
      const outcome = await openPerformance(db, await requestDeps(request), {
        commandId,
        activityId: id,
        roundId: round.id,
        scope: body.scope,
        performanceId,
        contestantId: body.contestantId,
        sequence: body.sequence,
      });
      return reply.status(outcome.status).send(outcome.body);
    },
  );

  app.post(
    "/api/activities/:id/competition/rounds/:roundKey/performances/:performanceId/lock",
    { schema: { params: CompetitionPerformanceParams, body: CompetitionScopeBodySchema } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id, roundKey, performanceId } = request.params as { id: string; roundKey: string; performanceId: string };
      const body = request.body as { scope: string };
      const round = await routeRound(id, roundKey);
      const outcome = await lockPerformance(db, await requestDeps(request), {
        commandId,
        activityId: id,
        roundId: round.id,
        performanceId,
        scope: body.scope,
      });
      return reply.status(outcome.status).send(outcome.body);
    },
  );

  app.post(
    "/api/activities/:id/competition/rounds/:roundKey/performances/:performanceId/advance",
    { schema: { params: CompetitionPerformanceParams, body: AdvanceCompetitionPerformanceBodySchema } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id, roundKey, performanceId } = request.params as { id: string; roundKey: string; performanceId: string };
      const body = request.body as { scope: string; nextContestantId: string; nextSequence: number };
      // Authenticate before resolving the round so an anonymous caller cannot
      // distinguish a missing activity from a forbidden one.
      const context = await requestDeps(request);
      const round = await routeRound(id, roundKey);
      const outcome = await advancePerformance(db, context, {
        commandId,
        activityId: id,
        roundId: round.id,
        currentPerformanceId: performanceId,
        nextContestantId: body.nextContestantId,
        nextSequence: body.nextSequence,
        scope: body.scope,
      });
      return reply.status(outcome.status).send(outcome.body);
    },
  );

  app.post(
    "/api/activities/:id/competition/rounds/:roundKey/lock",
    { schema: { params: CompetitionRoundParamsSchema, body: LockCompetitionRoundBodySchema } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id, roundKey } = request.params as { id: string; roundKey: string };
      const body = request.body as { scope: string; expectedRevision: number };
      const round = await routeRound(id, roundKey);
      const outcome = await lockRound(db, await requestDeps(request), {
        commandId,
        activityId: id,
        roundId: round.id,
        expectedRevision: body.expectedRevision,
        scope: body.scope,
      });
      return reply.status(outcome.status).send(outcome.body);
    },
  );

  app.post(
    "/api/activities/:id/competition/rounds/:roundKey/reopen-for-correction",
    { schema: { params: CompetitionRoundParamsSchema, body: ReopenCompetitionRoundBodySchema } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id, roundKey } = request.params as { id: string; roundKey: string };
      const body = request.body as { scope: string; expectedRevision: number; reason: string };
      const round = await routeRound(id, roundKey);
      const outcome = await reopenRoundForCorrection(db, await requestDeps(request), {
        commandId,
        activityId: id,
        roundId: round.id,
        expectedRevision: body.expectedRevision,
        scope: body.scope,
        reason: body.reason,
      });
      return reply.status(outcome.status).send(outcome.body);
    },
  );

  app.post(
    "/api/activities/:id/competition/rounds/:roundKey/scores",
    { schema: { params: CompetitionRoundParamsSchema, body: CompetitionScoreBodySchema } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id, roundKey } = request.params as { id: string; roundKey: string };
      const body = request.body as {
        scope: string;
        source: "direct_judge" | "staff_rapid" | "staff_proxy" | "paper_dr";
        performanceId: string;
        panelSnapshotId: string;
        seatId: string;
        contextVersion: number;
        criteria: Record<string, number>;
        notes?: string;
        sourceReference?: string;
        reason?: string;
      };
      if (body.source === "direct_judge" && cookieValue(request, "artflow_judge_session") !== undefined) {
        await requirePublicRateLimit(request, "judge-score", 60);
      }
      const round = await routeRound(id, roundKey);
      const base = {
        commandId,
        activityId: id,
        roundId: round.id,
        performanceId: body.performanceId,
        panelSnapshotId: body.panelSnapshotId,
        seatId: body.seatId,
        contextVersion: body.contextVersion,
        criteria: body.criteria,
        ...(body.notes === undefined ? {} : { notes: body.notes }),
        scope: body.scope,
      };
      const outcome = body.source === "direct_judge"
        ? await submitJudgeScore(db, await judgeScoreDeps(request), base)
        : body.source === "staff_rapid"
          ? await submitRapidScore(db, await requestDeps(request), base)
          : body.source === "staff_proxy"
            ? await submitProxyScore(db, await requestDeps(request), { ...base, sourceReference: body.sourceReference ?? "", reason: body.reason ?? "" })
            : await submitPaperScore(db, await requestDeps(request), { ...base, sourceReference: body.sourceReference ?? "", reason: body.reason ?? "" });
      return reply.status(outcome.status).send(outcome.body);
    },
  );

  const ScoreFactParams = Type.Object({
    id: Type.String({ minLength: 1 }),
    roundKey: Type.String({ minLength: 1, maxLength: 100 }),
    scoreFactId: Type.String({ minLength: 1, maxLength: 100 }),
  }, { additionalProperties: false });

  app.patch(
    "/api/activities/:id/competition/rounds/:roundKey/scores/:scoreFactId",
    { schema: { params: ScoreFactParams, body: EditCompetitionScoreBodySchema } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id, roundKey, scoreFactId } = request.params as { id: string; roundKey: string; scoreFactId: string };
      const body = request.body as {
        scope: string;
        performanceId: string;
        panelSnapshotId: string;
        seatId: string;
        contextVersion: number;
        expectedVersion: number;
        criteria: Record<string, number>;
        reason: string;
        correctionId?: string;
      };
      const round = await routeRound(id, roundKey);
      const outcome = await editScoreFact(db, await requestDeps(request), {
        commandId,
        activityId: id,
        roundId: round.id,
        performanceId: body.performanceId,
        panelSnapshotId: body.panelSnapshotId,
        seatId: body.seatId,
        contextVersion: body.contextVersion,
        expectedVersion: body.expectedVersion,
        criteria: body.criteria,
        reason: body.reason,
        correctionId: body.correctionId,
        scoreFactId,
        scope: body.scope,
      });
      return reply.status(outcome.status).send(outcome.body);
    },
  );

  app.post(
    "/api/activities/:id/competition/rounds/:roundKey/scores/:scoreFactId/corrections",
    { schema: { params: ScoreFactParams, body: OpenScoreCorrectionBodySchema } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id, roundKey, scoreFactId } = request.params as { id: string; roundKey: string; scoreFactId: string };
      const body = request.body as { scope: string; performanceId: string; panelSnapshotId: string; reason: string };
      const round = await routeRound(id, roundKey);
      const outcome = await openScoreCorrection(db, await requestDeps(request), {
        commandId,
        activityId: id,
        roundId: round.id,
        performanceId: body.performanceId,
        scoreFactId,
        panelSnapshotId: body.panelSnapshotId,
        scope: body.scope,
        reason: body.reason,
      });
      return reply.status(outcome.status).send(outcome.body);
    },
  );

  const ScoreCorrectionParams = Type.Object({
    id: Type.String({ minLength: 1 }),
    roundKey: Type.String({ minLength: 1, maxLength: 100 }),
    scoreFactId: Type.String({ minLength: 1, maxLength: 100 }),
    correctionId: Type.String({ minLength: 1, maxLength: 100 }),
  }, { additionalProperties: false });

  app.post(
    "/api/activities/:id/competition/rounds/:roundKey/scores/:scoreFactId/corrections/:correctionId/close",
    { schema: { params: ScoreCorrectionParams, body: ScoreCorrectionLifecycleBodySchema } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id, roundKey, scoreFactId, correctionId } = request.params as { id: string; roundKey: string; scoreFactId: string; correctionId: string };
      const body = request.body as { scope: string; panelSnapshotId: string; performanceId?: string };
      const round = await routeRound(id, roundKey);
      const outcome = await closeScoreCorrection(db, await requestDeps(request), {
        commandId,
        activityId: id,
        roundId: round.id,
        performanceId: body.performanceId,
        scoreFactId,
        correctionId,
        panelSnapshotId: body.panelSnapshotId,
        scope: body.scope,
      });
      return reply.status(outcome.status).send(outcome.body);
    },
  );

  app.post(
    "/api/activities/:id/competition/rounds/:roundKey/scores/:scoreFactId/corrections/:correctionId/recalculate",
    { schema: { params: ScoreCorrectionParams, body: ScoreCorrectionLifecycleBodySchema } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id, roundKey, scoreFactId, correctionId } = request.params as { id: string; roundKey: string; scoreFactId: string; correctionId: string };
      const body = request.body as { scope: string; panelSnapshotId: string; performanceId?: string };
      const round = await routeRound(id, roundKey);
      const outcome = await recalculateAfterCorrection(db, await requestDeps(request), {
        commandId,
        activityId: id,
        roundId: round.id,
        performanceId: body.performanceId,
        scoreFactId,
        correctionId,
        panelSnapshotId: body.panelSnapshotId,
        scope: body.scope,
      });
      return reply.status(outcome.status).send(outcome.body);
    },
  );

  app.post(
    "/api/activities/:id/competition/rounds/:roundKey/resolve",
    { schema: { params: RoundParams, body: ResolveCompetitionBodySchema } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id, roundKey } = request.params as { id: string; roundKey: string };
      const body = request.body as { scope: string };
      const round = await routeRound(id, roundKey);
      const outcome = await resolveRound(db, await requestDeps(request), {
        commandId,
        activityId: id,
        roundId: round.id,
        scope: body.scope,
      });
      return reply.status(outcome.status).send(outcome.body);
    },
  );

  app.post(
    "/api/activities/:id/competition/rounds/:roundKey/reset-rehearsal",
    { schema: { params: CompetitionRoundParamsSchema, body: ResetRehearsalBodySchema } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id, roundKey } = request.params as { id: string; roundKey: string };
      const body = request.body as { scope: string; mode: "test" | "rehearsal" };
      const round = await routeRound(id, roundKey);
      const outcome = await resetRehearsalRound(db, await requestDeps(request), {
        commandId,
        activityId: id,
        roundId: round.id,
        scope: body.scope,
        mode: body.mode,
      });
      return reply.status(outcome.status).send(outcome.body);
    },
  );

  app.post(
    "/api/activities/:id/competition/rounds/:roundKey/advancement/finalize",
    { schema: { params: CompetitionRoundParamsSchema, body: FinalizeAdvancementBodySchema } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id, roundKey } = request.params as { id: string; roundKey: string };
      const body = request.body as { scope: string; expectedRankingRevision: number };
      const round = await routeRound(id, roundKey);
      const outcome = await finalizeAdvancement(db, await requestDeps(request), {
        commandId,
        activityId: id,
        roundId: round.id,
        expectedRankingRevision: body.expectedRankingRevision,
        scope: body.scope,
      });
      return reply.status(outcome.status).send(outcome.body);
    },
  );

  const TieParams = Type.Object({
    id: Type.String({ minLength: 1 }),
    roundKey: Type.String({ minLength: 1, maxLength: 100 }),
    tieId: Type.String({ minLength: 1, maxLength: 100 }),
  }, { additionalProperties: false });

  app.post(
    "/api/activities/:id/competition/rounds/:roundKey/ties/:tieId/decide",
    { schema: { params: TieParams, body: TieDecisionBodySchema } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id, roundKey, tieId } = request.params as { id: string; roundKey: string; tieId: string };
      const body = request.body as { scope: string; rankingSnapshotId: string; inputFingerprint: string; contestants: string[]; order: string[]; reason: string };
      const round = await routeRound(id, roundKey);
      const outcome = await recordTieDecision(db, await requestDeps(request), {
        commandId,
        activityId: id,
        roundId: round.id,
        rankingSnapshotId: body.rankingSnapshotId,
        tieId,
        inputFingerprint: body.inputFingerprint,
        contestants: body.contestants,
        order: body.order,
        reason: body.reason,
        scope: body.scope,
      });
      return reply.status(outcome.status).send(outcome.body);
    },
  );

  app.get(
    "/api/activities/:id/competition/rounds/:roundKey/ranking",
    { schema: { params: RoundParams, querystring: CompetitionRankingQuerySchema }, config: { access: "operations" } },
    async (request) => {
      const { id, roundKey } = request.params as { id: string; roundKey: string };
      const query = request.query as { mode?: "test" | "rehearsal" | "formal" };
      const round = await routeRound(id, roundKey);
      const ranking = await getCurrentRankingSnapshot(db, round.id, query.mode ?? "formal");
      if (ranking === null) throw new DomainError("NOT_FOUND", "The ranking was not found.");
      return ranking;
    },
  );

  app.get(
    "/api/activities/:id/competition/rounds/:roundKey/scores",
    {
      schema: {
        params: RoundParams,
        querystring: CompetitionRoundScoresQuerySchema,
        response: { 200: CompetitionRoundScoresResponseSchema },
      },
      config: { access: "competition" },
    },
    async (request) => {
      const { id, roundKey } = request.params as { id: string; roundKey: string };
      const { scope } = request.query as { scope: string };
      const round = await routeRound(id, roundKey);
      return getRoundScores(db, { activityId: id, roundId: round.id, scope });
    },
  );

  app.post(
    "/api/activities/:id/competition/podium/recompute",
    { schema: { params: ActivityParams, body: RecomputePodiumBodySchema } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id } = request.params as { id: string };
      const body = request.body as { scope: string; roundIds: string[]; expectedInputFingerprint: string };
      const outcome = await recomputePodiumCandidate(db, await requestDeps(request), {
        commandId,
        activityId: id,
        roundIds: body.roundIds,
        expectedInputFingerprint: body.expectedInputFingerprint,
        scope: body.scope,
      });
      return reply.status(outcome.status).send(outcome.body);
    },
  );

  app.post(
    "/api/activities/:id/judge-entry/reissue",
    { schema: { params: ActivityParams, body: ReasonBodySchema } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id } = request.params as { id: string };
      const body = request.body as { reason: string };
      const outcome = await reissueJudgeCapability(db, await requestDeps(request), { commandId, activityId: id, reason: body.reason });
      reply.header("cache-control", "no-store");
      return reply.status(outcome.status).send(outcome.body);
    },
  );

  app.post(
    "/api/activities/:id/judge-entry/close",
    { schema: { params: ActivityParams, body: ReasonBodySchema } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id } = request.params as { id: string };
      const body = request.body as { reason: string };
      const outcome = await closeJudgeEntry(db, await requestDeps(request), { commandId, activityId: id, reason: body.reason });
      return reply.status(outcome.status).send(outcome.body);
    },
  );
}
