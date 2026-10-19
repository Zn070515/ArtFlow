import {
  ActivateCompetitionPanelBodySchema,
  CloseExecutionBodySchema,
  CompetitionRoundParamsSchema,
  CompetitionScoreBodySchema,
  CompetitionScopeBodySchema,
  errorResponse,
  ExecutionModeSchema,
  EditCompetitionScoreBodySchema,
  OpenCompetitionPerformanceBodySchema,
  OpenScoreCorrectionBodySchema,
  PackInstantiateBodySchema,
  PrepareCompetitionRoundBodySchema,
  ResolveCompetitionBodySchema,
  StartExecutionBodySchema,
  TieDecisionBodySchema,
} from "@artflow-plus/contracts";
import { checkReady, getCurrentRankingSnapshot, getRoundByKey, type Database } from "@artflow-plus/db";
import {
  defaultCapabilityRegistry,
  DomainError,
  instantiateActivityPack,
  SINGER_COMPETITION_PACK,
} from "@artflow-plus/domain";
import type {
  ActivityDefinitionPackage,
  ActivityPack,
  ActorContext,
  CapabilityRegistry,
  ExecutionMode,
} from "@artflow-plus/domain";
import {
  activateActivity,
  appendRuntimeFact,
  authenticateLocalAccount,
  closeExecution,
  compileDefinition,
  createActivity,
  defaultRuntimeDeps,
  getActivity,
  getExecutionState,
  listEvents,
  listExecutions,
  finalizeRoster,
  activateCompetitionPanel,
  editScoreFact,
  lockPerformance,
  openPerformance,
  openScoreCorrection,
  prepareCompetitionRound,
  recordTieDecision,
  resolveRound,
  submitJudgeScore,
  submitPaperScore,
  submitProxyScore,
  submitRapidScore,
  readMaterialForActor,
  reviewMaterial,
  reviewRegistration,
  resolveActorFromBearer,
  saveRegistrationAnswer,
  startRegistration,
  submitRegistration,
  uploadMaterial,
  releaseDefinitionCommand,
  startExecution,
} from "@artflow-plus/runtime";
import type { RuntimeDeps } from "@artflow-plus/runtime";
import swagger from "@fastify/swagger";
import { Type } from "@sinclair/typebox";
import type { Kysely } from "kysely";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";

export interface AppOptions {
  readonly db: Kysely<Database>;
  readonly registry?: CapabilityRegistry;
  readonly packs?: readonly ActivityPack[];
  readonly deps?: RuntimeDeps;
  /** M3 has no login; the actor is injected, never read from a request body. */
  readonly actor?: ActorContext;
  /** Exposes the generic capability fact seam for the M3 skeleton proof. */
  readonly enableRuntimeFacts?: boolean;
}

const STATUS_BY_CODE: Readonly<Record<string, number>> = {
  INVALID_INPUT: 400,
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  QUESTION_UNKNOWN: 422,
  MATERIAL_NOT_ALLOWED: 422,
  ROSTER_UNKNOWN: 409,
  NOT_FOUND: 404,
  CROSS_ACTIVITY: 404,
  STALE_REVISION: 409,
  INVALID_TRANSITION: 409,
  COMMAND_ID_CONFLICT: 409,
  COMMAND_IN_PROGRESS: 409,
  COMPOSITION_INVALID: 422,
  ACTIVITY_NOT_ACTIVE: 409,
  CAPABILITY_NOT_ENABLED: 409,
  CAPABILITY_VERSION_MISMATCH: 409,
  RUNTIME_CONTRACT_MISMATCH: 409,
  SCOPE_UNDECLARED: 422,
  VERSION_NOT_RELEASED: 409,
  SESSION_NOT_RUNNING: 409,
  DEFINITION_NOT_COMPILED: 409,
  SCOPE_ALREADY_RUNNING: 409,
  SCOPE_CONFLICT: 409,
  TEST_FORMAL_CONFLICT: 409,
  ACTIVITY_HAS_RUNNING_SESSIONS: 409,
  DEFINITION_HASH_MISMATCH: 422,
  DEFINITION_INVALID: 422,
  RELEASE_SNAPSHOT_INCOMPLETE: 422,
  ROUND_UNKNOWN: 422,
  ROUND_ALREADY_PREPARED: 409,
  ROUND_NOT_PREPARED: 409,
  ROUND_LOCKED: 409,
  PANEL_ALREADY_ACTIVE: 409,
  PANEL_NOT_ACTIVE: 409,
  PERFORMANCE_ALREADY_OPEN: 409,
  PERFORMANCE_NOT_OPEN: 409,
  PERFORMANCE_LOCKED: 409,
  PERFORMANCE_SCORE_OPEN: 409,
  SCORE_GATE_OPEN: 409,
  NO_PERFORMANCES: 409,
  JUDGE_ROSTER_INVALID: 422,
  DUPLICATE_SCORE_FACT: 409,
  STALE_CONTEXT: 409,
  PERFORMANCE_NOT_SCORABLE: 409,
  SOURCE_REFERENCE_REQUIRED: 422,
  CORRECTION_REQUIRED: 422,
  SCORE_FACT_LOCKED: 409,
  SCORE_FACT_NOT_FOUND: 404,
  CORRECTION_NOT_FOUND: 404,
  CORRECTION_ALREADY_OPEN: 409,
  STALE_RESOLUTION_INPUT: 409,
  TIE_DECISION_REQUIRED: 422,
  TIE_DECISION_INVALID: 422,
};

const CreateActivityBody = Type.Object(
  {
    title: Type.String({ minLength: 1, maxLength: 200 }),
    capabilities: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 80 }), { uniqueItems: true }),
    ),
    packId: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
    answers: Type.Optional(Type.Record(Type.String(), Type.Boolean())),
    enable: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 80 }), { uniqueItems: true }),
    ),
    disable: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 80 }), { uniqueItems: true }),
    ),
  },
  { additionalProperties: false },
);

const ActivityParams = Type.Object(
  { id: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);

const PackParams = Type.Object(
  { id: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);

const SessionParams = Type.Object(
  { id: Type.String({ minLength: 1 }), sessionId: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);

const ActivateBody = Type.Object(
  { expectedRevision: Type.Integer({ minimum: 0 }) },
  { additionalProperties: false },
);

const CompileBody = Type.Object(
  {
    package: Type.Unknown(),
    expectedDraftRevision: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

const ReleaseBody = Type.Object(
  { expectedDraftRevision: Type.Integer({ minimum: 0 }) },
  { additionalProperties: false },
);

const EventsQuery = Type.Object(
  {
    after: Type.Optional(Type.Integer({ minimum: 0 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
    mode: Type.Optional(ExecutionModeSchema),
  },
  { additionalProperties: false },
);

const StateQuery = Type.Object(
  { mode: Type.Optional(ExecutionModeSchema) },
  { additionalProperties: false },
);

const RuntimeFactBody = Type.Object(
  {
    capability: Type.String({ pattern: "^[a-z][a-z0-9_-]*$", maxLength: 80 }),
    scope: Type.String({ pattern: "^[a-z][a-z0-9_-]*$", maxLength: 100 }),
    type: Type.String({ pattern: "^[A-Z][A-Za-z0-9]+$", maxLength: 100 }),
    payload: Type.Unknown(),
  },
  { additionalProperties: false },
);

const LoginBody = Type.Object(
  {
    username: Type.String({ minLength: 1, maxLength: 100 }),
    password: Type.String({ minLength: 1, maxLength: 200 }),
  },
  { additionalProperties: false },
);

const RegistrationBody = Type.Object(
  { participantId: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })) },
  { additionalProperties: false },
);

const RegistrationParams = Type.Object(
  { id: Type.String({ minLength: 1 }), registrationId: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);

const AnswerBody = Type.Object(
  {
    expectedRevision: Type.Integer({ minimum: 0 }),
    questionKey: Type.String({ minLength: 1, maxLength: 100 }),
    value: Type.Unknown(),
  },
  { additionalProperties: false },
);

const SubmitBody = Type.Object(
  { expectedRevision: Type.Integer({ minimum: 0 }) },
  { additionalProperties: false },
);

const ReviewRegistrationBody = Type.Object(
  {
    expectedRevision: Type.Integer({ minimum: 0 }),
    status: Type.Union([Type.Literal("approved"), Type.Literal("need_supplement"), Type.Literal("rejected")]),
    note: Type.String({ maxLength: 2000 }),
  },
  { additionalProperties: false },
);

const MaterialBody = Type.Object(
  {
    registrationId: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
    questionKey: Type.String({ minLength: 1, maxLength: 100 }),
    originalName: Type.String({ minLength: 1, maxLength: 255 }),
    contentType: Type.String({ minLength: 1, maxLength: 150 }),
    byteLength: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

const MaterialParams = Type.Object(
  { id: Type.String({ minLength: 1 }), materialId: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);

const RegistrationMaterialParams = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    registrationId: Type.String({ minLength: 1 }),
    materialId: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

const ReviewMaterialBody = Type.Object(
  {
    expectedRevision: Type.Integer({ minimum: 0 }),
    status: Type.Union([Type.Literal("approved"), Type.Literal("needs_supplement")]),
    note: Type.String({ maxLength: 2000 }),
  },
  { additionalProperties: false },
);

const RoundParams = Type.Object(
  { id: Type.String({ minLength: 1 }), roundKey: Type.String({ minLength: 1, maxLength: 100 }) },
  { additionalProperties: false },
);

const PrepareRoundBody = Type.Object(
  { scope: Type.String({ minLength: 1, maxLength: 100 }) },
  { additionalProperties: false },
);

function requireIdempotency(request: FastifyRequest): string {
  const header = request.headers["idempotency-key"];
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== "string" || !value.trim()) {
    throw new DomainError("INVALID_INPUT", "An Idempotency-Key header is required.");
  }
  return value.trim();
}

function bearerToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== "string") return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match?.[1];
}

function asPackage(value: unknown): ActivityDefinitionPackage {
  if (value === null || typeof value !== "object") {
    throw new DomainError("INVALID_INPUT", "A definition package object is required.");
  }
  const candidate = value as Partial<ActivityDefinitionPackage>;
  if (
    candidate.schemaVersion !== 1 ||
    candidate.manifest === undefined ||
    candidate.capabilities === null ||
    typeof candidate.capabilities !== "object"
  ) {
    throw new DomainError(
      "INVALID_INPUT",
      "A definition package needs schemaVersion 1, a manifest and a capabilities object.",
    );
  }
  return candidate as ActivityDefinitionPackage;
}

function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  const code = (error as { code: unknown }).code;
  return typeof code === "string" ? code : null;
}

function errorDetails(error: unknown): unknown {
  if (typeof error === "object" && error !== null && "issues" in error) {
    return (error as { issues: unknown }).issues;
  }
  return undefined;
}

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const { db } = options;
  const registry = options.registry ?? defaultCapabilityRegistry;
  const packs = options.packs ?? [SINGER_COMPETITION_PACK];
  const baseDeps = options.deps ?? defaultRuntimeDeps();
  const deps =
    options.actor === undefined ? baseDeps : { ...baseDeps, actor: options.actor };

  async function requestActor(request: FastifyRequest): Promise<ActorContext> {
    if (options.actor !== undefined) return options.actor;
    if (baseDeps.actor !== undefined && baseDeps.actor.actorId !== "system") {
      return baseDeps.actor;
    }
    const actor = await resolveActorFromBearer(db, bearerToken(request));
    if (actor === null) {
      throw new DomainError("UNAUTHENTICATED", "A valid Bearer session is required.");
    }
    return actor;
  }

  async function requestDeps(request: FastifyRequest): Promise<RuntimeDeps> {
    return { ...deps, actor: await requestActor(request) };
  }

  async function routeRound(activityId: string, roundKey: string) {
    const round = await getRoundByKey(db, activityId, roundKey);
    if (round === null) throw new DomainError("NOT_FOUND", "The competition round was not found.");
    return round;
  }

  await app.register(swagger, {
    openapi: {
      info: { title: "ArtFlow-Plus API", version: "0.0.0" },
    },
  });

  app.get("/healthz", async () => ({ status: "ok" }));
  app.get("/readyz", async (_request, reply) => {
    try {
      await checkReady(db);
      return { status: "ok" };
    } catch {
      // The generic status deliberately does not leak the failure detail.
      return reply.status(503).send({ status: "unavailable" });
    }
  });
  app.get("/openapi.json", { schema: { hide: true } }, async () => app.swagger());

  app.post(
    "/api/auth/login",
    { schema: { body: LoginBody } },
    async (request) => {
      const body = request.body as { username: string; password: string };
      const result = await authenticateLocalAccount(db, body);
      return { token: result.token, expiresAt: result.expiresAt };
    },
  );

  app.get("/api/capabilities", async () => ({
    capabilities: registry.list().map((registration) => registration.manifest),
  }));

  app.get("/api/packs", async () => ({ packs }));

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

  app.post(
    "/api/activities",
    { schema: { body: CreateActivityBody } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const body = request.body as {
        title: string;
        capabilities?: string[];
        packId?: string;
        answers?: Record<string, boolean>;
        enable?: string[];
        disable?: string[];
      };
      let capabilities = body.capabilities;
      let initialDefinition: ActivityDefinitionPackage | undefined;
      if (body.packId !== undefined) {
        const pack = packs.find((candidate) => candidate.identity === body.packId);
        if (pack === undefined) {
          throw new DomainError("NOT_FOUND", `Pack ${body.packId} was not found.`);
        }
        const instantiated = instantiateActivityPack(pack, registry, {
          title: body.title,
          ...(body.answers === undefined ? {} : { answers: body.answers }),
          ...(body.enable === undefined ? {} : { enable: body.enable }),
          ...(body.disable === undefined ? {} : { disable: body.disable }),
        });
        if (!instantiated.ok) {
          return reply
            .status(422)
            .send(
              errorResponse(
                "PACK_COMPOSITION_INVALID",
                `Pack ${body.packId} cannot be instantiated.`,
                instantiated.issues,
              ),
            );
        }
        capabilities = [...instantiated.instantiation.enabledCapabilities];
        initialDefinition = instantiated.instantiation.definition;
      }
      const outcome = await createActivity(db, registry, deps, {
        commandId,
        title: body.title,
        ...(capabilities === undefined ? {} : { capabilities }),
        ...(initialDefinition === undefined ? {} : { initialDefinition }),
      });
      return reply.status(outcome.status).send(outcome.body);
    },
  );

  app.get("/api/activities/:id", { schema: { params: ActivityParams } }, async (request) => {
    const { id } = request.params as { id: string };
    const activity = await getActivity(db, id);
    if (activity === null) {
      throw new DomainError("NOT_FOUND", `Activity ${id} was not found.`);
    }
    return activity;
  });

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
    { schema: { params: MaterialParams } },
    async (request) => {
      const { id, materialId } = request.params as { id: string; materialId: string };
      return readMaterialForActor(db, {
        activityId: id,
        materialId,
        actor: await requestActor(request),
      });
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
      const { id, roundKey } = request.params as { id: string; roundKey: string };
      const body = request.body as { scope: string; contestantId: string; sequence: number };
      const round = await routeRound(id, roundKey);
      const outcome = await openPerformance(db, await requestDeps(request), {
        commandId,
        activityId: id,
        roundId: round.id,
        scope: body.scope,
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
        ? await submitJudgeScore(db, await requestDeps(request), base)
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
        scope: body.scope,
      });
      if (outcome.body.id !== scoreFactId) throw new DomainError("SCORE_FACT_NOT_FOUND", "The score fact was not found.");
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
        rankingSnapshotId: body.rankingSnapshotId || tieId,
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
    { schema: { params: RoundParams, querystring: CompetitionScopeBodySchema } },
    async (request) => {
      await requestActor(request);
      const { id, roundKey } = request.params as { id: string; roundKey: string };
      const round = await routeRound(id, roundKey);
      const ranking = await getCurrentRankingSnapshot(db, round.id);
      if (ranking === null) throw new DomainError("NOT_FOUND", "The ranking was not found.");
      return ranking;
    },
  );

  app.post(
    "/api/activities/:id/activate",
    { schema: { params: ActivityParams, body: ActivateBody } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id } = request.params as { id: string };
      const body = request.body as { expectedRevision: number };
      const outcome = await activateActivity(db, deps, {
        commandId,
        activityId: id,
        expectedRevision: body.expectedRevision,
      });
      return reply.status(outcome.status).send(outcome.body);
    },
  );

  app.post(
    "/api/activities/:id/definitions/compile",
    { schema: { params: ActivityParams, body: CompileBody } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id } = request.params as { id: string };
      const body = request.body as {
        package: unknown;
        expectedDraftRevision?: number;
      };
      const outcome = await compileDefinition(db, registry, deps, {
        commandId,
        activityId: id,
        package: asPackage(body.package),
        ...(body.expectedDraftRevision === undefined
          ? {}
          : { expectedDraftRevision: body.expectedDraftRevision }),
      });
      return reply.status(outcome.status).send(outcome.body);
    },
  );

  app.post(
    "/api/activities/:id/definitions/release",
    { schema: { params: ActivityParams, body: ReleaseBody } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id } = request.params as { id: string };
      const body = request.body as { expectedDraftRevision: number };
      const outcome = await releaseDefinitionCommand(db, registry, deps, {
        commandId,
        activityId: id,
        expectedDraftRevision: body.expectedDraftRevision,
      });
      return reply.status(outcome.status).send(outcome.body);
    },
  );

  app.post(
    "/api/activities/:id/executions",
    { schema: { params: ActivityParams, body: StartExecutionBodySchema } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id } = request.params as { id: string };
      const body = request.body as {
        scope: string;
        mode: ExecutionMode;
        expectedRevision?: number;
      };
      const outcome = await startExecution(db, registry, deps, {
        commandId,
        activityId: id,
        scope: body.scope,
        mode: body.mode,
        ...(body.expectedRevision === undefined
          ? {}
          : { expectedRevision: body.expectedRevision }),
      });
      return reply.status(outcome.status).send(outcome.body);
    },
  );

  app.post(
    "/api/activities/:id/executions/:sessionId/close",
    { schema: { params: SessionParams, body: CloseExecutionBodySchema } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id, sessionId } = request.params as { id: string; sessionId: string };
      const body = request.body as { expectedRevision: number };
      const outcome = await closeExecution(db, deps, {
        commandId,
        activityId: id,
        sessionId,
        expectedRevision: body.expectedRevision,
      });
      return reply.status(outcome.status).send(outcome.body);
    },
  );

  app.get(
    "/api/activities/:id/executions",
    { schema: { params: ActivityParams } },
    async (request) => {
      const { id } = request.params as { id: string };
      const activity = await getActivity(db, id);
      if (activity === null) {
        throw new DomainError("NOT_FOUND", `Activity ${id} was not found.`);
      }
      return { sessions: await listExecutions(db, id) };
    },
  );

  app.get(
    "/api/activities/:id/execution-state",
    { schema: { params: ActivityParams, querystring: StateQuery } },
    async (request) => {
      const { id } = request.params as { id: string };
      const query = request.query as { mode?: ExecutionMode };
      const activity = await getActivity(db, id);
      if (activity === null) {
        throw new DomainError("NOT_FOUND", `Activity ${id} was not found.`);
      }
      return getExecutionState(db, id, query.mode ?? "formal");
    },
  );

  app.get(
    "/api/activities/:id/events",
    { schema: { params: ActivityParams, querystring: EventsQuery } },
    async (request) => {
      const { id } = request.params as { id: string };
      const query = request.query as {
        after?: number;
        limit?: number;
        mode?: ExecutionMode;
      };
      const activity = await getActivity(db, id);
      if (activity === null) {
        throw new DomainError("NOT_FOUND", `Activity ${id} was not found.`);
      }
      return listEvents(db, {
        activityId: id,
        after: query.after ?? 0,
        limit: query.limit ?? 100,
        ...(query.mode === undefined ? {} : { mode: query.mode }),
      });
    },
  );

  app.get(
    "/api/activities/:id/stream",
    { schema: { params: ActivityParams, querystring: EventsQuery } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const query = request.query as {
        after?: number;
        mode?: ExecutionMode;
      };
      const activity = await getActivity(db, id);
      if (activity === null) {
        throw new DomainError("NOT_FOUND", `Activity ${id} was not found.`);
      }
      const headerCursor = request.headers["last-event-id"];
      const fromHeader = Array.isArray(headerCursor) ? headerCursor[0] : headerCursor;
      const parsedHeader =
        typeof fromHeader === "string" && /^\d+$/.test(fromHeader)
          ? Number(fromHeader)
          : 0;

      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      raw.flushHeaders();
      let cursor = query.after ?? parsedHeader;
      let closed = false;
      let polling = false;
      const close = (): void => {
        if (closed) return;
        closed = true;
        clearInterval(poll);
        clearInterval(heartbeat);
        raw.end();
      };
      const poll = setInterval(() => {
        // Never overlap two reads: a slow query must not emit duplicate frames.
        if (closed || polling) return;
        polling = true;
        void listEvents(db, {
          activityId: id,
          after: cursor,
          limit: 100,
          ...(query.mode === undefined ? {} : { mode: query.mode }),
        })
          .then((feed) => {
            if (closed) return;
            for (const event of feed.events) {
              raw.write(`id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`);
              cursor = event.sequence;
            }
          })
          .catch(() => {
            // Realtime is an enhancement; close and let the client poll.
            close();
          })
          .finally(() => {
            polling = false;
          });
      }, 500);
      const heartbeat = setInterval(() => {
        if (!closed) raw.write(": heartbeat\n\n");
      }, 15_000);
      request.raw.on("close", close);
      raw.on("error", close);
      await new Promise<void>((resolve) => {
        request.raw.on("close", resolve);
      });
    },
  );

  if (options.enableRuntimeFacts === true) {
    app.post(
      "/api/activities/:id/runtime-facts",
      { schema: { params: ActivityParams, body: RuntimeFactBody } },
      async (request, reply) => {
        const commandId = requireIdempotency(request);
        const { id } = request.params as { id: string };
        const body = request.body as {
          capability: string;
          scope: string;
          type: string;
          payload: unknown;
        };
        const outcome = await appendRuntimeFact(db, registry, deps, {
          commandId,
          activityId: id,
          capability: body.capability,
          scope: body.scope,
          type: body.type,
          payload: body.payload,
        });
        return reply.status(outcome.status).send(outcome.body);
      },
    );
  }

  app.setErrorHandler((error, request, reply) => {
    const code = errorCode(error);
    if (code !== null) {
      const status = STATUS_BY_CODE[code] ?? 400;
      const details = errorDetails(error);
      return reply
        .status(status)
        .send(
          errorResponse(
            code,
            error instanceof Error ? error.message : "The command was refused.",
            details,
          ),
        );
    }
    const failure = error as {
      validation?: unknown;
      statusCode?: number;
      message?: string;
    };
    if (
      failure.validation !== undefined ||
      (failure.statusCode !== undefined && failure.statusCode < 500)
    ) {
      return reply
        .status(400)
        .send(errorResponse("VALIDATION_FAILED", failure.message ?? "Invalid request."));
    }
    request.log.error(error as Error);
    return reply
      .status(500)
      .send(errorResponse("INTERNAL_ERROR", "An unexpected error occurred."));
  });

  return app;
}
