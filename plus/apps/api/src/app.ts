import {
  errorResponse,
  PackInstantiateBodySchema,
} from "@artflow-plus/contracts";
import {
  activateActivity,
  compileActivityDefinitionPackage,
  createActivity,
  createDefinitionDraft,
  defaultCapabilityRegistry,
  DomainError,
  instantiateActivityPack,
  releaseDefinition,
  SINGER_COMPETITION_PACK,
  updateDefinitionDraft,
} from "@artflow-plus/domain";
import type {
  Activity,
  ActivityDefinitionPackage,
  ActivityPack,
  CapabilityCompiler,
  CapabilityRegistry,
  CompiledActivityDefinition,
  DefinitionDraft,
  ReleasedActivityDefinition,
} from "@artflow-plus/domain";
import swagger from "@fastify/swagger";
import { Type } from "@sinclair/typebox";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";

interface Entry {
  activity: Activity;
  draft?: DefinitionDraft;
  compiled?: CompiledActivityDefinition;
  version?: ReleasedActivityDefinition;
}

export interface AppOptions {
  registry?: CapabilityRegistry;
  packs?: readonly ActivityPack[];
  compilers?: readonly CapabilityCompiler[];
  now?: () => string;
}

const STATUS_BY_CODE: Readonly<Record<string, number>> = {
  INVALID_INPUT: 400,
  VALIDATION_FAILED: 400,
  NOT_FOUND: 404,
  CROSS_ACTIVITY: 404,
  STALE_REVISION: 409,
  INVALID_TRANSITION: 409,
  ACTIVITY_NOT_ACTIVE: 409,
  CAPABILITY_NOT_ENABLED: 409,
  VERSION_NOT_RELEASED: 409,
  DEFINITION_NOT_COMPILED: 409,
  SCOPE_ALREADY_RUNNING: 409,
  SCOPE_CONFLICT: 409,
  TEST_FORMAL_CONFLICT: 409,
  ACTIVITY_HAS_RUNNING_SESSIONS: 409,
  DEFINITION_HASH_MISMATCH: 422,
  DEFINITION_INVALID: 422,
};

const CreateActivityBody = Type.Object(
  {
    title: Type.String({ minLength: 1, maxLength: 200 }),
    capabilities: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 80 }), { uniqueItems: true }),
    ),
  },
  { additionalProperties: false },
);

const ActivityParams = Type.Object({ id: Type.String({ minLength: 1 }) }, {
  additionalProperties: false,
});

const PackParams = Type.Object({ id: Type.String({ minLength: 1 }) }, {
  additionalProperties: false,
});

const ActivateBody = Type.Object(
  { expectedRevision: Type.Integer({ minimum: 0 }) },
  { additionalProperties: false },
);

const CompileBody = Type.Object(
  { package: Type.Unknown() },
  { additionalProperties: false },
);

const ReleaseBody = Type.Object(
  { expectedDraftRevision: Type.Integer({ minimum: 0 }) },
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

export async function buildApp(options: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const registry = options.registry ?? defaultCapabilityRegistry;
  const compilers = options.compilers ?? registry.compilers;
  const packs = options.packs ?? [SINGER_COMPETITION_PACK];
  const now = options.now ?? (() => new Date().toISOString());
  const entries = new Map<string, Entry>();
  let nextId = 0;

  await app.register(swagger, {
    openapi: {
      info: { title: "ArtFlow-Plus API", version: "0.0.0" },
    },
  });

  app.get("/healthz", async () => ({ status: "ok" }));
  app.get("/readyz", async () => ({ status: "ok" }));
  app.get("/openapi.json", { schema: { hide: true } }, async () => app.swagger());

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
      requireIdempotency(request);
      const body = request.body as { title: string; capabilities?: string[] };
      const id = `act-${++nextId}`;
      const activity = createActivity({
        id,
        title: body.title,
        capabilities: body.capabilities,
      });
      entries.set(id, { activity });
      return reply.status(201).send({
        id: activity.id,
        status: activity.status,
        revision: activity.revision,
        enabledCapabilities: activity.enabledCapabilities,
      });
    },
  );

  app.post(
    "/api/activities/:id/activate",
    { schema: { params: ActivityParams, body: ActivateBody } },
    async (request, reply) => {
      requireIdempotency(request);
      const { id } = request.params as { id: string };
      const entry = entries.get(id);
      if (entry === undefined) {
        throw new DomainError("NOT_FOUND", `Activity ${id} was not found.`);
      }
      const body = request.body as { expectedRevision: number };
      entry.activity = activateActivity(entry.activity, body.expectedRevision);
      return reply.send({
        id: entry.activity.id,
        status: entry.activity.status,
        revision: entry.activity.revision,
      });
    },
  );

  app.post(
    "/api/activities/:id/definitions/compile",
    { schema: { params: ActivityParams, body: CompileBody } },
    async (request, reply) => {
      requireIdempotency(request);
      const { id } = request.params as { id: string };
      const entry = entries.get(id);
      if (entry === undefined) {
        throw new DomainError("NOT_FOUND", `Activity ${id} was not found.`);
      }
      const body = request.body as { package: unknown };
      const definitionPackage = asPackage(body.package);
      const compiled = compileActivityDefinitionPackage(definitionPackage, compilers);
      if (!compiled.ok) {
        return reply
          .status(422)
          .send(errorResponse("DEFINITION_INVALID", "The definition package is invalid.", compiled.issues));
      }
      const base = entry.draft ?? createDefinitionDraft(entry.activity);
      entry.draft = updateDefinitionDraft(base, base.revision, definitionPackage);
      entry.compiled = compiled;
      return reply.send({
        contentHash: compiled.contentHash,
        capabilities: Object.keys(compiled.capabilities).sort(),
        diagnostics: [],
      });
    },
  );

  app.post(
    "/api/activities/:id/definitions/release",
    { schema: { params: ActivityParams, body: ReleaseBody } },
    async (request, reply) => {
      requireIdempotency(request);
      const { id } = request.params as { id: string };
      const entry = entries.get(id);
      if (entry === undefined) {
        throw new DomainError("NOT_FOUND", `Activity ${id} was not found.`);
      }
      if (entry.draft === undefined || entry.compiled === undefined) {
        throw new DomainError(
          "DEFINITION_NOT_COMPILED",
          "Compile the current definition package before releasing it.",
        );
      }
      const body = request.body as { expectedDraftRevision: number };
      const result = releaseDefinition({
        activity: entry.activity,
        draft: entry.draft,
        expectedDraftRevision: body.expectedDraftRevision,
        compiled: entry.compiled,
        releasedAt: now(),
      });
      entry.activity = result.activity;
      entry.version = result.version;
      return reply.status(201).send({
        activityId: result.version.activityId,
        version: result.version.version,
        contentHash: result.version.contentHash,
      });
    },
  );

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof DomainError) {
      const status = STATUS_BY_CODE[error.code] ?? 400;
      return reply.status(status).send(errorResponse(error.code, error.message));
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
