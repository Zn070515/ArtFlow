import { errorResponse } from "@artflow-plus/contracts";
import { getRoundByKey, type Database } from "@artflow-plus/db";
import { defaultCapabilityRegistry, DomainError, hasPermission, requirePermission, REVIEW_AWARDS_PACK, SINGER_COMPETITION_PACK, STAGE_SHOW_PACK, SYSTEM_ACTOR, VOTE_POLL_PACK } from "@artflow-plus/domain";
import type { ActivityPack, ActorContext, CapabilityRegistry } from "@artflow-plus/domain";
import { defaultRuntimeDeps, resolveActorFromBearer, csrfTokenFor, resolveLocalSession, ACTIVITY_ANALYTICS_READ_PERMISSIONS } from "@artflow-plus/runtime";
import { MemoryRateLimiter } from "@artflow-plus/runtime";
import type { RateLimiter, RuntimeDeps } from "@artflow-plus/runtime";
import swagger from "@fastify/swagger";
import { timingSafeEqual } from "node:crypto";
import type { Kysely } from "kysely";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest, type FastifyServerOptions } from "fastify";
import { createRealtimeServer } from "@artflow-plus/realtime/server";
import { isProductionEnvironment, sessionCookie } from "./cookies.js";
import { createActivityRealtimeTopic, createVotingRealtimeTopic } from "./realtime-topics.js";
import type { ApiContext } from "./http/context.js";
import { bearerToken, cookieValue, errorCode, errorDetails, isDriverErrorCode, publicErrorMessage } from "./http/helpers.js";
import { registerActivityRoutes } from "./routes/activity.js";
import { registerArchiveRoutes } from "./routes/archive.js";
import { registerAttendanceRoutes } from "./routes/attendance.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerCompetitionRoutes } from "./routes/competition.js";
import { registerGroupingRoutes } from "./routes/grouping.js";
import { registerPublicRoutes } from "./routes/public.js";
import { registerPublishingRoutes } from "./routes/publishing.js";
import { registerRegistrationRoutes } from "./routes/registration.js";
import { registerSystemRoutes } from "./routes/system.js";
import { registerTasksRoutes } from "./routes/tasks.js";
import { registerVotingRoutes } from "./routes/voting.js";

export interface AppOptions {
  readonly db: Kysely<Database>;
  readonly registry?: CapabilityRegistry;
  readonly packs?: readonly ActivityPack[];
  readonly deps?: RuntimeDeps;
  /** M3 has no login; the actor is injected, never read from a request body. */
  readonly actor?: ActorContext;
  /** Exposes the generic capability fact seam for the M3 skeleton proof. */
  readonly enableRuntimeFacts?: boolean;
  /** Gateway/app limiter seam; public capability entry fails closed if it errors. */
  readonly rateLimiter?: RateLimiter;
  /** Explicit trusted proxy addresses/CIDRs; empty by default. */
  readonly trustProxy?: FastifyServerOptions["trustProxy"];
}

export function parseTrustedProxy(value = process.env.ARTFLOW_PLUS_TRUST_PROXY): string[] {
  if (value === undefined || value.trim() === "") return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function selectRateLimiter(
  options: Pick<AppOptions, "rateLimiter">,
  env: NodeJS.ProcessEnv = process.env,
): RateLimiter {
  if (options.rateLimiter !== undefined) return options.rateLimiter;
  if (isProductionEnvironment(env)) {
    throw new Error("A shared RateLimiter must be supplied in production.");
  }
  return new MemoryRateLimiter();
}

const STATUS_BY_CODE: Readonly<Record<string, number>> = {
  INVALID_INPUT: 400,
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  QUESTION_UNKNOWN: 422,
  MATERIAL_NOT_ALLOWED: 422,
  ROSTER_UNKNOWN: 409,
  ROSTER_FINAL: 409,
  REGISTRATION_CLOSED: 409,
  MATERIAL_CONTENT_UNAVAILABLE: 409,
  FORMAL_FACTS_EXIST: 409,
  NOT_FOUND: 404,
  CROSS_ACTIVITY: 404,
  POINT_NOT_FOUND: 404,
  POINT_KEY_TAKEN: 409,
  POINT_INACTIVE: 409,
  POINT_TYPE_IN_USE: 409,
  SUBJECT_TYPE_NOT_ALLOWED: 409,
  SUBJECT_NOT_ELIGIBLE: 409,
  ALREADY_CHECKED_IN: 409,
  NOT_CHECKED_IN: 409,
  INVALID_MODE: 409,
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
  RELEASE_REISSUE_REQUIRED: 409,
  ROUND_UNKNOWN: 422,
  ROUND_ALREADY_PREPARED: 409,
  ROUND_NOT_PREPARED: 409,
  ROUND_LOCKED: 409,
  ROUND_RELEASE_IMMUTABLE: 409,
  PANEL_ALREADY_ACTIVE: 409,
  PANEL_NOT_ACTIVE: 409,
  PERFORMANCE_ALREADY_OPEN: 409,
  PERFORMANCE_NOT_OPEN: 409,
  PERFORMANCE_LOCKED: 409,
  PERFORMANCE_SCORE_OPEN: 409,
  SCORE_GATE_OPEN: 409,
  NO_PERFORMANCES: 409,
  JUDGE_ROSTER_INVALID: 422,
  CONTESTANT_NOT_IN_ROSTER: 409,
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
  VOTE_SESSION_NOT_OPEN: 409,
  VOTE_SESSION_CLOSED: 409,
  DUPLICATE_BALLOT: 409,
  BALLOT_IDENTITY_INVALID: 422,
  OPTION_NOT_IN_SESSION: 422,
  TOO_MANY_SELECTIONS: 422,
  TICKET_REQUIRED: 403,
  INVALID_TICKET: 404,
  TICKET_REPLAYED: 409,
  JUDGE_ENTRY_CLOSED: 409,
  INVALID_JUDGE_ENTRY: 404,
  SEAT_UNAVAILABLE: 409,
  TICKET_SESSION_EXPIRED: 401,
  TICKET_SESSION_REVOKED: 401,
  RESULT_POST_FROZEN: 409,
  RESULT_ALREADY_RELEASED: 409,
  RESULT_RELEASE_NOT_ACTIVE: 409,
  RESULT_NOT_CONFIRMED: 409,
  RESULT_CANDIDATE_HOLD: 409,
  AWARD_INVALID: 422,
  FORMAL_MODE_REQUIRED: 409,
  CSRF_INVALID: 403,
  USERNAME_TAKEN: 409,
  ACTIVITY_ARCHIVED: 409,
  ARCHIVE_RESULT_NOT_RELEASED: 409,
  ARCHIVE_ROUND_NOT_LOCKED: 409,
  ARCHIVE_CORRECTION_OPEN: 409,
  ARCHIVE_VOTE_SESSION_OPEN: 409,
  ARCHIVE_INTEGRITY_FAILED: 409,
  ARCHIVE_NOT_FOUND: 404,
  RATE_LIMITED: 429,
};

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    trustProxy: options.trustProxy ?? parseTrustedProxy(),
  });
  // Material bytes are uploaded as a raw body; keep the limit aligned with the
  // released materials policy and reject oversize bodies before the handler.
  app.addContentTypeParser(
    "application/octet-stream",
    // The transport limit is a global safety ceiling; the released materials
    // policy is the authority and may allow up to 100 MiB (stage shows).
    { parseAs: "buffer", bodyLimit: 128 * 1024 * 1024 },
    (_request, body, done) => done(null, body),
  );
  const { db } = options;
  const registry = options.registry ?? defaultCapabilityRegistry;
  const packs = options.packs ?? [
    SINGER_COMPETITION_PACK,
    STAGE_SHOW_PACK,
    REVIEW_AWARDS_PACK,
    VOTE_POLL_PACK,
  ];
  const baseDeps = options.deps ?? defaultRuntimeDeps();
  const rateLimiter = selectRateLimiter(options);
  const deps =
    options.actor === undefined ? baseDeps : { ...baseDeps, actor: options.actor };

  const isProduction = isProductionEnvironment();
  const sessionSecret =
    deps.credentialSecret ??
    process.env.ARTFLOW_PLUS_CREDENTIAL_SECRET ??
    (isProduction ? "" : "artflow-plus-development-secret");
  if (sessionSecret === "") {
    throw new Error("ARTFLOW_PLUS_CREDENTIAL_SECRET is required in production.");
  }

  function setSessionCookies(reply: FastifyReply, token: string, csrf: string): void {
    const secure = isProductionEnvironment();
    const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();
    reply.header("set-cookie", [
      sessionCookie("artflow_session", token, expiresAt, secure),
      sessionCookie("artflow_csrf", csrf, expiresAt, secure, { httpOnly: false }),
    ]);
  }

  function clearSessionCookies(reply: FastifyReply): void {
    const secure = isProductionEnvironment();
    const expiredAt = new Date(0).toISOString();
    reply.header("set-cookie", [
      sessionCookie("artflow_session", "", expiredAt, secure),
      sessionCookie("artflow_csrf", "", expiredAt, secure, { httpOnly: false }),
    ]);
  }

  function publicActor(actor: ActorContext): ActorContext {
    const { authContext: _authContext, ...rest } = actor;
    return rest;
  }

  async function requestSession(request: FastifyRequest) {
    const token = cookieValue(request, "artflow_session") ?? bearerToken(request);
    if (token === undefined || token.trim() === "") return null;
    return resolveLocalSession(db, token.trim(), new Date().toISOString());
  }

  async function requestActor(request: FastifyRequest): Promise<ActorContext> {
    if (options.actor !== undefined) return options.actor;
    if (baseDeps.actor !== undefined && baseDeps.actor.actorId !== "system") {
      return baseDeps.actor;
    }
    const actor = await resolveActorFromBearer(
      db,
      cookieValue(request, "artflow_session") ?? bearerToken(request),
    );
    if (actor === null) {
      throw new DomainError("UNAUTHENTICATED", "A valid session is required.");
    }
    return actor;
  }

  async function requestDeps(request: FastifyRequest): Promise<RuntimeDeps> {
    return { ...deps, actor: await requestActor(request) };
  }

  async function requireStudio(request: FastifyRequest): Promise<RuntimeDeps> {
    const requestContext = await requestDeps(request);
    requirePermission(requestContext.actor ?? SYSTEM_ACTOR, "studio.manage");
    return requestContext;
  }

  const OPERATIONS_READ_PERMISSIONS = ["studio.manage", "competition.manage", "judge.manage"] as const;

  // The event feed carries judge scores/notes and registration review notes; only
  // the operational surfaces that already hold these facts may read it.
  async function requireOperationsReader(request: FastifyRequest): Promise<void> {
    const actor = await requestActor(request);
    if (!OPERATIONS_READ_PERMISSIONS.some((permission) => hasPermission(actor, permission))) {
      throw new DomainError("FORBIDDEN", "An operations permission is required.");
    }
  }

  // Every GET route must declare its read surface. The default is not "public":
  // an undeclared route fails at boot, so a new endpoint cannot quietly become
  // an anonymous internal read.
  type ReadAccess = "public" | "session" | "operations" | "analytics" | "studio" | "tasks" | "attendance" | "voting" | "result" | "archive";
  const READ_ACCESS_PERMISSIONS: Readonly<Record<"analytics" | "tasks" | "attendance" | "voting" | "result" | "archive", readonly string[]>> = {
    analytics: ACTIVITY_ANALYTICS_READ_PERMISSIONS,
    tasks: [
      "tasks.manage",
      "studio.manage",
      "competition.manage",
      "judge.manage",
      "registration.manage",
      "registration.review",
      "materials.manage",
      "materials.review",
      "grouping.manage",
      "voting.manage",
      "result.manage",
      "archive.manage",
      "ticket.manage",
    ],
    attendance: [
      "attendance.manage",
      "studio.manage",
      "competition.manage",
      "judge.manage",
      "registration.manage",
      "registration.review",
      "materials.manage",
      "materials.review",
      "grouping.manage",
      "voting.manage",
      "result.manage",
      "archive.manage",
      "ticket.manage",
    ],
    voting: ["voting.manage", "result.manage"],
    result: ["result.manage"],
    archive: ["archive.manage"],
  };

  async function requireReadAccess(request: FastifyRequest, access: ReadAccess): Promise<void> {
    if (access === "public") return;
    if (access === "session") {
      await requestActor(request);
      return;
    }
    if (access === "operations") {
      await requireOperationsReader(request);
      return;
    }
    if (access === "studio") {
      await requireStudio(request);
      return;
    }
    const actor = await requestActor(request);
    const allowed = [...READ_ACCESS_PERMISSIONS[access], ...OPERATIONS_READ_PERMISSIONS];
    if (!allowed.some((permission) => hasPermission(actor, permission))) {
      throw new DomainError("FORBIDDEN", `One of the ${access} read permissions is required.`);
    }
  }

  app.addHook("onRoute", (route) => {
    if (route.method !== "GET") return;
    // Swagger's documentation routes and the WebSocket upgrade endpoint are not
    // part of the HTTP read surface.
    if (!route.url.startsWith("/api/") && route.url !== "/healthz" && route.url !== "/readyz" && route.url !== "/openapi.json") {
      return;
    }
    if (route.url === "/api/realtime") return;
    const access = (route.config as { access?: ReadAccess } | undefined)?.access;
    if (access === undefined) {
      throw new Error(`GET ${route.url} must declare config.access (public, session, operations, analytics, studio, tasks, attendance, voting, result, archive).`);
    }
    const guard = async (request: FastifyRequest): Promise<void> => {
      await requireReadAccess(request, access);
    };
    const existing = route.preHandler;
    route.preHandler = existing === undefined
      ? [guard]
      : Array.isArray(existing)
        ? [...existing, guard]
        : [existing, guard];
  });

  // The Live console opens and closes scoring sessions without Studio access.
  async function requireSessionManager(request: FastifyRequest): Promise<RuntimeDeps> {
    const requestContext = await requestDeps(request);
    const actor = requestContext.actor ?? SYSTEM_ACTOR;
    if (!hasPermission(actor, "studio.manage") && !hasPermission(actor, "competition.manage")) {
      throw new DomainError("FORBIDDEN", "One of studio.manage or competition.manage is required.");
    }
    return requestContext;
  }

  function publicDeps(): RuntimeDeps {
    return { ...deps, actor: SYSTEM_ACTOR };
  }

  async function judgeScoreDeps(request: FastifyRequest): Promise<RuntimeDeps> {
    const sessionToken = cookieValue(request, "artflow_judge_session");
    if (sessionToken !== undefined) return { ...publicDeps(), judgeSessionToken: sessionToken };
    return requestDeps(request);
  }

  async function requireRateLimit(key: string, limit: number): Promise<void> {
    try {
      const allowed = await rateLimiter.allow({ key, limit, windowMs: 60_000 });
      if (!allowed) throw new DomainError("RATE_LIMITED", "The public action is rate limited.");
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError("RATE_LIMITED", "The public action is temporarily unavailable.");
    }
  }

  async function requirePublicRateLimit(request: FastifyRequest, key: string, limit: number): Promise<void> {
    await requireRateLimit(`${key}:${request.ip}`, limit);
  }

  async function routeRound(activityId: string, roundKey: string) {
    const round = await getRoundByKey(db, activityId, roundKey);
    if (round === null) throw new DomainError("NOT_FOUND", "The competition round was not found.");
    return round;
  }

  app.addHook("onRequest", async (request) => {
    if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") return;
    if (
      request.url.startsWith("/api/auth/login") ||
      request.url.startsWith("/api/auth/register") ||
      request.url.startsWith("/api/auth/logout")
    ) {
      return;
    }
    if (bearerToken(request) !== undefined) return;
    const sessionToken = cookieValue(request, "artflow_session");
    if (sessionToken === undefined) return;
    const provided = request.headers["x-csrf-token"];
    const expected = csrfTokenFor(sessionToken, sessionSecret);
    const providedText = typeof provided === "string" ? provided : "";
    const left = Buffer.from(providedText);
    const right = Buffer.from(expected);
    if (left.length !== right.length || !timingSafeEqual(left, right)) {
      throw new DomainError("CSRF_INVALID", "A valid CSRF token is required.");
    }
  });

  await app.register(swagger, {
    openapi: {
      info: { title: "ArtFlow-Plus API", version: "0.0.0" },
    },
  });

  const routeContext: ApiContext = {
    app, db, deps, baseDeps, registry, packs, rateLimiter, isProduction,
    sessionSecret, enableRuntimeFacts: options.enableRuntimeFacts === true,
    setSessionCookies, clearSessionCookies, publicActor, requestSession,
    requestActor, requestDeps, requireStudio, requireOperationsReader,
    requireReadAccess, requireSessionManager, publicDeps, judgeScoreDeps,
    requireRateLimit, requirePublicRateLimit, routeRound,
  };
  registerSystemRoutes(routeContext);
  registerAuthRoutes(routeContext);
  registerActivityRoutes(routeContext);
  registerTasksRoutes(routeContext);
  registerAttendanceRoutes(routeContext);
  registerRegistrationRoutes(routeContext);
  registerGroupingRoutes(routeContext);
  registerCompetitionRoutes(routeContext);
  registerVotingRoutes(routeContext);
  registerArchiveRoutes(routeContext);
  registerPublishingRoutes(routeContext);
  registerPublicRoutes(routeContext);


  app.setErrorHandler((error, request, reply) => {
    const failure = error as {
      validation?: unknown;
      statusCode?: number;
      message?: string;
      code?: unknown;
    };
    if (
      !isDriverErrorCode(failure.code) &&
      (failure.validation !== undefined || (failure.statusCode !== undefined && failure.statusCode < 500))
    ) {
      const status = failure.validation === undefined ? failure.statusCode ?? 400 : 400;
      return reply
        .status(status)
        .send(errorResponse("VALIDATION_FAILED", publicErrorMessage(status, failure.message ?? "Invalid request.")));
    }
    const code = errorCode(error);
    if (code !== null) {
      const status = STATUS_BY_CODE[code] ?? 400;
      const details = errorDetails(error);
      return reply
        .status(status)
        .send(
          errorResponse(
            code,
            publicErrorMessage(
              status,
              error instanceof Error ? error.message : "The command was refused.",
            ),
            details,
          ),
        );
    }
    request.log.error(error as Error);
    return reply
      .status(500)
      .send(errorResponse("INTERNAL_ERROR", "An unexpected error occurred."));
  });

  const realtime = await createRealtimeServer({
    fastify: app,
    authenticate: async (request) => {
      try {
        return await requestActor(request);
      } catch {
        return null;
      }
    },
    topics: [createVotingRealtimeTopic(db), createActivityRealtimeTopic(db)],
  });
  app.addHook("onClose", async () => {
    await realtime.close();
  });

  return app;
}
