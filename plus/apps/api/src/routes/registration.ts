import type { ApiContext } from "../http/context.js";
import { DomainError } from "@artflow-plus/domain";
import { attachMaterialContent, finalizeRoster, getMyRegistration, getRegistrationDetail, getRosterForReview, issueSupplementGrant, listRegistrationsForReview, readMaterialContent, readMaterialForActor, reopenRoster, reviewMaterial, reviewRegistration, saveRegistrationAnswer, startRegistration, submitRegistration, uploadMaterial } from "@artflow-plus/runtime";
import { ActivityParams, AnswerBody, MaterialBody, MaterialParams, RegistrationBody, RegistrationMaterialParams, RegistrationParams, ReopenRosterBody, ReviewMaterialBody, ReviewRegistrationBody, SubmitBody } from "../http/schemas.js";
import { requireIdempotency } from "../http/helpers.js";

export function registerRegistrationRoutes(ctx: ApiContext): void {
  const {
    app, db, deps, baseDeps, registry, packs, rateLimiter, isProduction,
    sessionSecret, enableRuntimeFacts,
    setSessionCookies, clearSessionCookies, publicActor, requestSession,
    requestActor, requestDeps, requireStudio, requireOperationsReader,
    requireReadAccess, requireSessionManager, publicDeps, judgeScoreDeps,
    requireRateLimit, requirePublicRateLimit, routeRound,
  } = ctx;

  app.get(
    "/api/activities/:id/registrations/mine",
    { schema: { params: ActivityParams }, config: { access: "session" } },
    async (request) => {
      const { id } = request.params as { id: string };
      const registration = await getMyRegistration(db, await requestDeps(request), id);
      if (registration === null) {
        throw new DomainError("NOT_FOUND", "You have no registration for this activity.");
      }
      return registration;
    },
  );

  app.get(
    "/api/activities/:id/registrations/:registrationId",
    { schema: { params: RegistrationParams }, config: { access: "session" } },
    async (request) => {
      const { id, registrationId } = request.params as { id: string; registrationId: string };
      return getRegistrationDetail(db, await requestDeps(request), id, registrationId);
    },
  );

  app.get(
    "/api/activities/:id/registrations",
    { schema: { params: ActivityParams }, config: { access: "session" } },
    async (request) => {
      const { id } = request.params as { id: string };
      return {
        registrations: await listRegistrationsForReview(db, await requestDeps(request), id),
      };
    },
  );

  app.get(
    "/api/activities/:id/roster",
    { schema: { params: ActivityParams }, config: { access: "session" } },
    async (request) => {
      const { id } = request.params as { id: string };
      return { roster: await getRosterForReview(db, await requestDeps(request), id) };
    },
  );

  app.post(
    "/api/activities/:id/registrations",
    { schema: { params: ActivityParams, body: RegistrationBody } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id } = request.params as { id: string };
      const body = request.body as { participantId?: string };
      const actor = await requestActor(request);
      const outcome = await startRegistration(db, { ...deps, actor }, {
        commandId,
        activityId: id,
        participantId: body.participantId ?? actor.actorId,
      });
      return reply.status(outcome.status).send(outcome.body);
    },
  );

  app.patch(
    "/api/activities/:id/registrations/:registrationId",
    { schema: { params: RegistrationParams, body: AnswerBody } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id, registrationId } = request.params as { id: string; registrationId: string };
      const body = request.body as { expectedRevision: number; questionKey: string; value: unknown };
      const outcome = await saveRegistrationAnswer(db, await requestDeps(request), {
        commandId,
        activityId: id,
        registrationId,
        expectedRevision: body.expectedRevision,
        questionKey: body.questionKey,
        value: body.value,
      });
      return reply.status(outcome.status).send(outcome.body);
    },
  );

  app.patch(
    "/api/activities/:id/registrations/:registrationId/answers",
    { schema: { params: RegistrationParams, body: AnswerBody } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id, registrationId } = request.params as { id: string; registrationId: string };
      const body = request.body as { expectedRevision: number; questionKey: string; value: unknown };
      const outcome = await saveRegistrationAnswer(db, await requestDeps(request), {
        commandId,
        activityId: id,
        registrationId,
        expectedRevision: body.expectedRevision,
        questionKey: body.questionKey,
        value: body.value,
      });
      return reply.status(outcome.status).send(outcome.body);
    },
  );

  app.post(
    "/api/activities/:id/registrations/:registrationId/submit",
    { schema: { params: RegistrationParams, body: SubmitBody } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id, registrationId } = request.params as { id: string; registrationId: string };
      const body = request.body as { expectedRevision: number };
      const outcome = await submitRegistration(db, await requestDeps(request), {
        commandId,
        activityId: id,
        registrationId,
        expectedRevision: body.expectedRevision,
      });
      return reply.status(outcome.status).send(outcome.body);
    },
  );

  app.post(
    "/api/activities/:id/registrations/:registrationId/review",
    { schema: { params: RegistrationParams, body: ReviewRegistrationBody } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id, registrationId } = request.params as { id: string; registrationId: string };
      const body = request.body as {
        expectedRevision: number;
        status: "approved" | "need_supplement" | "rejected";
        note: string;
      };
      const outcome = await reviewRegistration(db, await requestDeps(request), {
        commandId,
        activityId: id,
        registrationId,
        expectedRevision: body.expectedRevision,
        status: body.status,
        note: body.note,
      });
      return reply.status(outcome.status).send(outcome.body);
    },
  );

  app.post(
    "/api/activities/:id/registrations/:registrationId/supplement",
    { schema: { params: RegistrationParams } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id, registrationId } = request.params as { id: string; registrationId: string };
      const body = request.body as { allowedKeys: string[] };
      if (!Array.isArray(body.allowedKeys)) {
        throw new DomainError("INVALID_INPUT", "allowedKeys must be an array.");
      }
      const outcome = await issueSupplementGrant(db, await requestDeps(request), {
        commandId,
        activityId: id,
        registrationId,
        allowedKeys: body.allowedKeys,
      });
      return reply.status(outcome.status).send(outcome.body);
    },
  );

  app.post(
    "/api/activities/:id/roster/finalize",
    { schema: { params: ActivityParams, body: SubmitBody } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id } = request.params as { id: string };
      const body = request.body as { expectedRevision: number };
      const outcome = await finalizeRoster(db, await requestDeps(request), {
        commandId,
        activityId: id,
        expectedRevision: body.expectedRevision,
      });
      return reply.status(outcome.status).send(outcome.body);
    },
  );

  app.post(
    "/api/activities/:id/roster/reopen",
    { schema: { params: ActivityParams, body: ReopenRosterBody } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id } = request.params as { id: string };
      const body = request.body as { expectedRevision: number; reason: string };
      const outcome = await reopenRoster(db, await requestDeps(request), {
        commandId,
        activityId: id,
        expectedRevision: body.expectedRevision,
        reason: body.reason,
      });
      return reply.status(outcome.status).send(outcome.body);
    },
  );

  app.post(
    "/api/activities/:id/materials",
    { schema: { params: ActivityParams, body: MaterialBody } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id } = request.params as { id: string };
      const body = request.body as {
        registrationId?: string;
        questionKey: string;
        originalName: string;
        contentType: string;
        byteLength: number;
      };
      const outcome = await uploadMaterial(db, await requestDeps(request), {
        commandId,
        activityId: id,
        registrationId: body.registrationId ?? "",
        questionKey: body.questionKey,
        originalName: body.originalName,
        contentType: body.contentType,
        byteLength: body.byteLength,
      });
      return reply.status(outcome.status).send(outcome.body);
    },
  );

  app.post(
    "/api/activities/:id/registrations/:registrationId/materials",
    { schema: { params: RegistrationParams, body: MaterialBody } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id, registrationId } = request.params as { id: string; registrationId: string };
      const body = request.body as {
        questionKey: string;
        originalName: string;
        contentType: string;
        byteLength: number;
      };
      const outcome = await uploadMaterial(db, await requestDeps(request), {
        commandId,
        activityId: id,
        registrationId,
        questionKey: body.questionKey,
        originalName: body.originalName,
        contentType: body.contentType,
        byteLength: body.byteLength,
      });
      return reply.status(outcome.status).send(outcome.body);
    },
  );

  app.get(
    "/api/activities/:id/materials/:materialId",
    { schema: { params: MaterialParams }, config: { access: "session" } },
    async (request) => {
      const { id, materialId } = request.params as { id: string; materialId: string };
      return readMaterialForActor(db, {
        activityId: id,
        materialId,
        actor: await requestActor(request),
      });
    },
  );

  app.get(
    "/api/activities/:id/materials/:materialId/content",
    { schema: { params: MaterialParams }, config: { access: "session" } },
    async (request, reply) => {
      const { id, materialId } = request.params as { id: string; materialId: string };
      const { material, bytes } = await readMaterialContent(db, await requestDeps(request), {
        activityId: id,
        materialId,
        actor: await requestActor(request),
      });
      return reply
        .type(material.contentType)
        .header("content-length", String(bytes.byteLength))
        .header("cache-control", "private, no-store")
        .send(Buffer.from(bytes));
    },
  );

  app.put(
    "/api/activities/:id/materials/:materialId/content",
    { schema: { params: MaterialParams } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id, materialId } = request.params as { id: string; materialId: string };
      const body = request.body;
      if (!Buffer.isBuffer(body)) {
        throw new DomainError("INVALID_INPUT", "Material content must be sent as application/octet-stream.");
      }
      const outcome = await attachMaterialContent(db, await requestDeps(request), {
        commandId,
        activityId: id,
        materialId,
        bytes: body,
      });
      return reply.status(outcome.status).send(outcome.body);
    },
  );

  app.post(
    "/api/activities/:id/materials/:materialId/review",
    { schema: { params: MaterialParams, body: ReviewMaterialBody } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id, materialId } = request.params as { id: string; materialId: string };
      const body = request.body as {
        expectedRevision: number;
        status: "approved" | "needs_supplement";
        note: string;
      };
      const outcome = await reviewMaterial(db, await requestDeps(request), {
        commandId,
        activityId: id,
        materialId,
        expectedRevision: body.expectedRevision,
        status: body.status,
        note: body.note,
      });
      return reply.status(outcome.status).send(outcome.body);
    },
  );

  app.post(
    "/api/activities/:id/registrations/:registrationId/materials/:materialId/review",
    { schema: { params: RegistrationMaterialParams, body: ReviewMaterialBody } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id, materialId } = request.params as { id: string; materialId: string };
      const body = request.body as {
        expectedRevision: number;
        status: "approved" | "needs_supplement";
        note: string;
      };
      const outcome = await reviewMaterial(db, await requestDeps(request), {
        commandId,
        activityId: id,
        materialId,
        expectedRevision: body.expectedRevision,
        status: body.status,
        note: body.note,
      });
      return reply.status(outcome.status).send(outcome.body);
    },
  );
}
