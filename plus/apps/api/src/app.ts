import {
  ActivateCompetitionPanelBodySchema,
  CloseExecutionBodySchema,
  FinalizeAdvancementBodySchema,
  LockCompetitionRoundBodySchema,
  ReopenCompetitionRoundBodySchema,
  CompetitionRoundParamsSchema,
  CompetitionRankingQuerySchema,
  CompetitionScoreBodySchema,
  CompetitionScopeBodySchema,
  errorResponse,
  ExecutionModeSchema,
  EditCompetitionScoreBodySchema,
  OpenCompetitionPerformanceBodySchema,
  OpenScoreCorrectionBodySchema,
  PackInstantiateBodySchema,
  PrepareCompetitionRoundBodySchema,
  ResetRehearsalBodySchema,
  ResolveCompetitionBodySchema,
  RecomputePodiumBodySchema,
  ScoreCorrectionLifecycleBodySchema,
  StartExecutionBodySchema,
  TieDecisionBodySchema,
  CloseVoteSessionBodySchema,
  JudgeEntryBodySchema,
  OpenVoteSessionBodySchema,
  ReasonBodySchema,
  SubmitBallotBodySchema,
  TicketCredentialBodySchema,
  ConfirmStageResultBodySchema,
  EditPublicationBodySchema,
  PublicResultsParamsSchema,
  PublicResultsQuerySchema,
  PublishingReleaseParamsSchema,
  PublishingStageParamsSchema,
  ReleaseResultBodySchema,
  RevokeResultReleaseBodySchema,
  UnlockStageResultBodySchema,
  ArchiveActivityBodySchema,
  ArchiveFileQuerySchema,
  CloseActivityBodySchema,
  RenameActivityBodySchema,
  UnarchiveActivityBodySchema,
  RegisterParticipantBodySchema,
  ParticipantClaimConsumeBodySchema,
} from "@artflow-plus/contracts";
import { checkReady, getCurrentRankingSnapshot, getLiveState, getOutboxRelayHealth, getRoundByKey, getVoteSession, revokeLocalSession, selectPublicResults, type Database } from "@artflow-plus/db";
import {
  defaultCapabilityRegistry,
  DomainError,
  hasPermission,
  instantiateActivityPack,
  requirePermission,
  REVIEW_AWARDS_PACK,
  SINGER_COMPETITION_PACK,
  STAGE_SHOW_PACK,
  SYSTEM_ACTOR,
  VOTE_POLL_PACK,
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
  authenticateTicketSession,
  getExecutionState,
  listEvents,
  listExecutions,
  finalizeRoster,
  activateCompetitionPanel,
  closeScoreCorrection,
  editScoreFact,
  finalizeAdvancement,
  lockRound,
  reopenRoundForCorrection,
  lockPerformance,
  openPerformance,
  openScoreCorrection,
  prepareCompetitionRound,
  recordTieDecision,
  recalculateAfterCorrection,
  recomputePodiumCandidate,
  resetRehearsalRound,
  resolveRound,
  submitJudgeScore,
  submitPaperScore,
  submitProxyScore,
  submitRapidScore,
  attachMaterialContent,
  getSupplementContext,
  issueSupplementGrant,
  readMaterialContent,
  submitSupplement,
  uploadSupplementMaterial,
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
  claimJudgeSeat,
  closeJudgeEntry,
  closeVoteSession,
  getClosedVoteScores,
  issueTicket,
  openVoteSession,
  reissueJudgeCapability,
  redeemTicketCredential,
  rotateTicketCredential,
  revokeTicket,
  revokeTicketAccessSession,
  submitBallot,
  confirmStageResult,
  confirmVoteStageResult,
  editPublication,
  getPublishingState,
  getVoteResultCandidate,
  releaseResult,
  revokeResultRelease,
  unlockStageResult,
  archiveActivity,
  closeActivity,
  getArchiveState,
  readArchiveFile,
  renameActivity,
  unarchiveActivity,
  csrfTokenFor,
  registerParticipantAccount,
  resolveLocalSession,
  getMyRegistration,
  getPublicActivity,
  getRegistrationDetail,
  getRosterForReview,
  listActivitiesForReview,
  listRegistrationsForReview,
  getStudioState,
  getJudgeContext,
  getLiveState as getLiveActivityState,
  readPublicVoteSession,
  readVotingSessionsState,
  cancelGroupingStage,
  confirmGroupingStage,
  correctGroupingStage,
  createGroupingStage,
  freezeGroupingStage,
  getGroupingState,
  recordGroupingGroups,
  setGroupingMaterialWindow,
  consumeParticipantClaim,
  issueParticipantClaim,
} from "@artflow-plus/runtime";
import { MemoryRateLimiter } from "@artflow-plus/runtime";
import type { RateLimiter, RuntimeDeps } from "@artflow-plus/runtime";
import swagger from "@fastify/swagger";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { Type } from "@sinclair/typebox";
import type { Kysely } from "kysely";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerOptions,
} from "fastify";

import { createRealtimeServer } from "@artflow-plus/realtime/server";

import { isProductionEnvironment, sessionCookie } from "./cookies.js";
import { createActivityRealtimeTopic, createVotingRealtimeTopic } from "./realtime-topics.js";

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
  LEGACY_BUNDLE_INVALID: 400,
  LEGACY_ACTIVITY_EXISTS: 409,
  LEGACY_RECONCILIATION_FAILED: 409,
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
  INVALID_PARTICIPANT_CLAIM: 400,
  RATE_LIMITED: 429,
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

const PublicVoteParams = Type.Object(
  { sessionId: Type.String({ minLength: 1, maxLength: 100 }) },
  { additionalProperties: false },
);

const PublicActivityParams = Type.Object(
  { publicCode: Type.String({ minLength: 1, maxLength: 100 }) },
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

const TicketParams = Type.Object(
  { id: Type.String({ minLength: 1 }), ticketId: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);

const TicketSessionParams = Type.Object(
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

const GroupingStageParams = Type.Object(
  { id: Type.String({ minLength: 1 }), stageId: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);

const CreateGroupingStageBody = Type.Object(
  {
    stageKey: Type.String({ minLength: 1, maxLength: 100 }),
    name: Type.String({ minLength: 1, maxLength: 200 }),
    rosterSource: Type.Union([Type.Literal("all_approved"), Type.Literal("round_advanced")]),
    sourceRoundId: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
  },
  { additionalProperties: false },
);

const GroupingGroupSpecSchema = Type.Object(
  {
    name: Type.Optional(Type.String({ maxLength: 200 })),
    participantIds: Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { minItems: 1 }),
  },
  { additionalProperties: false },
);

const RecordGroupingGroupsBody = Type.Object(
  {
    expectedRevision: Type.Integer({ minimum: 1 }),
    groups: Type.Array(GroupingGroupSpecSchema, { minItems: 1 }),
  },
  { additionalProperties: false },
);

const GroupingRevisionBody = Type.Object(
  { expectedRevision: Type.Integer({ minimum: 1 }) },
  { additionalProperties: false },
);

const CorrectGroupingBody = Type.Object(
  {
    expectedRevision: Type.Integer({ minimum: 1 }),
    groups: Type.Array(GroupingGroupSpecSchema, { minItems: 1 }),
    reason: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

const CancelGroupingBody = Type.Object(
  {
    expectedRevision: Type.Integer({ minimum: 1 }),
    reason: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

const GroupingWindowBody = Type.Object(
  {
    expectedRevision: Type.Integer({ minimum: 1 }),
    window: Type.Union([
      Type.Literal("closed"),
      Type.Literal("open"),
      Type.Literal("supplement_only"),
    ]),
    note: Type.Optional(Type.String({ maxLength: 500 })),
  },
  { additionalProperties: false },
);

const VoteResultParamsSchema = Type.Object(
  { id: Type.String({ minLength: 1 }), sessionId: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);

const ConfirmVoteResultBodySchema = Type.Object(
  {
    scope: Type.String({ minLength: 1, maxLength: 100 }),
    voteSessionId: Type.String({ minLength: 1, maxLength: 100 }),
    expectedSessionRevision: Type.Integer({ minimum: 1 }),
    expectedInputFingerprint: Type.String({ minLength: 1, maxLength: 128 }),
    awards: Type.Array(
      Type.Object(
        {
          award: Type.String({ minLength: 1, maxLength: 100 }),
          contestantId: Type.String({ minLength: 1, maxLength: 100 }),
        },
        { additionalProperties: false },
      ),
    ),
    note: Type.Optional(Type.String({ maxLength: 2000 })),
  },
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

function cookieValue(request: FastifyRequest, name: string): string | undefined {
  const header = request.headers.cookie;
  if (typeof header !== "string") return undefined;
  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 0) continue;
    if (pair.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(pair.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Responses redact one-time fields; replay-aware services may restore them only for cookie setting. */
function sessionTokenValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function setSessionCookie(reply: { header(name: string, value: string): unknown }, name: string, value: string, expiresAt: string): void {
  reply.header(
    "set-cookie",
    sessionCookie(name, value, expiresAt, isProductionEnvironment()),
  );
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
  const app = Fastify({
    logger: false,
    trustProxy: options.trustProxy ?? parseTrustedProxy(),
    ajv: { customOptions: { removeAdditional: false } },
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
  const rateLimiter = options.rateLimiter ?? new MemoryRateLimiter();
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
  const secureCookie = isProduction ? "; Secure" : "";

  function setSessionCookies(reply: FastifyReply, token: string, csrf: string): void {
    reply.header("set-cookie", [
      `artflow_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800${secureCookie}`,
      `artflow_csrf=${csrf}; Path=/; SameSite=Strict; Max-Age=28800${secureCookie}`,
    ]);
  }

  function clearSessionCookies(reply: FastifyReply): void {
    reply.header("set-cookie", [
      `artflow_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secureCookie}`,
      `artflow_csrf=; Path=/; SameSite=Strict; Max-Age=0${secureCookie}`,
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
  type ReadAccess = "public" | "session" | "operations" | "studio" | "voting" | "result" | "archive";
  const READ_ACCESS_PERMISSIONS: Readonly<Record<"voting" | "result" | "archive", readonly string[]>> = {
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
      throw new Error(`GET ${route.url} must declare config.access (public, session, operations, studio, voting, result, archive).`);
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

  app.get("/healthz", { config: { access: "public" } }, async () => ({ status: "ok" }));
  app.get("/readyz", { config: { access: "public" } }, async (_request, reply) => {
    try {
      await checkReady(db);
      return { status: "ok" };
    } catch {
      // The generic status deliberately does not leak the failure detail.
      return reply.status(503).send({ status: "unavailable" });
    }
  });
  app.get("/openapi.json", { schema: { hide: true }, config: { access: "public" } }, async () => app.swagger());

  app.post(
    "/api/auth/login",
    { schema: { body: LoginBody } },
    async (request, reply) => {
      const body = request.body as { username: string; password: string };
      await requirePublicRateLimit(request, "auth-login", 10);
      await requireRateLimit(`auth-login-user:${body.username.trim().toLowerCase()}`, 20);
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
    async (request) => {
      const body = request.body as { username: string; password: string };
      await requirePublicRateLimit(request, "auth-token", 10);
      await requireRateLimit(`auth-token-user:${body.username.trim().toLowerCase()}`, 20);
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

  app.get("/api/capabilities", { config: { access: "public" } }, async () => ({
    capabilities: registry.list().map((registration) => registration.manifest),
  }));

  app.get("/api/packs", { config: { access: "public" } }, async () => ({ packs }));

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
      const outcome = await createActivity(db, registry, await requireStudio(request), {
        commandId,
        title: body.title,
        ...(capabilities === undefined ? {} : { capabilities }),
        ...(initialDefinition === undefined ? {} : { initialDefinition }),
      });
      return reply.status(outcome.status).send(outcome.body);
    },
  );

  app.get("/api/activities", { config: { access: "session" } }, async (request) => ({
    activities: await listActivitiesForReview(db, await requestDeps(request)),
  }));

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
    async (request, reply) => {
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
    "/api/public/participant-claims/consume",
    { schema: { body: ParticipantClaimConsumeBodySchema }, config: { access: "public" } },
    async (request, reply) => {
      await requirePublicRateLimit(request, "participant-claim-consume", 10);
      const body = request.body as {
        token: string;
        username?: string;
        password?: string;
      };
      const session = await requestSession(request);
      const consumeDeps: RuntimeDeps = {
        ...deps,
        actor: session?.actor ?? SYSTEM_ACTOR,
      };
      const outcome = await consumeParticipantClaim(db, consumeDeps, {
        commandId: requireIdempotency(request),
        token: body.token,
        ...(body.username === undefined ? {} : { username: body.username }),
        ...(body.password === undefined ? {} : { password: body.password }),
      });
      const sessionToken = sessionTokenValue(outcome.body.sessionToken);
      let csrfToken: string | undefined;
      if (sessionToken !== undefined && !outcome.replayed) {
        csrfToken = csrfTokenFor(sessionToken, sessionSecret);
        setSessionCookies(reply, sessionToken, csrfToken);
      }
      reply.header("cache-control", "no-store");
      return reply.status(outcome.status).send({
        actor: publicActor(outcome.body.actor),
        publicCode: outcome.body.publicCode,
        ...(csrfToken === undefined ? {} : { csrfToken }),
        ...(outcome.body.expiresAt === undefined ? {} : { expiresAt: outcome.body.expiresAt }),
      });
    },
  );

  app.post(
    "/api/public/supplement/claim",
    { schema: { body: Type.Object({ token: Type.String({ minLength: 1 }) }, { additionalProperties: false }) }, config: { access: "public" } },
    async (request, reply) => {
      await requirePublicRateLimit(request, "supplement-claim", 20);
      const body = request.body as { token: string };
      const context = await getSupplementContext(db, body.token, deps.now());
      const secure = isProduction ? "; Secure" : "";
      reply.header(
        "set-cookie",
        `artflow_supplement=${body.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800${secure}`,
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
    "/api/activities/:id/studio",
    { schema: { params: ActivityParams }, config: { access: "studio" } },
    async (request) => {
      const { id } = request.params as { id: string };
      return getStudioState(db, await requireStudio(request), id);
    },
  );

  app.get("/api/activities/:id", { schema: { params: ActivityParams }, config: { access: "operations" } }, async (request) => {
    const { id } = request.params as { id: string };
    const activity = await getActivity(db, id);
    if (activity === null) {
      throw new DomainError("NOT_FOUND", `Activity ${id} was not found.`);
    }
    return activity;
  });

  app.get("/api/operations/outbox", { config: { access: "operations" } }, async () => {
    return getOutboxRelayHealth(db);
  });

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

  app.get(
    "/api/activities/:id/grouping",
    { schema: { params: ActivityParams }, config: { access: "session" } },
    async (request) => {
      const { id } = request.params as { id: string };
      return getGroupingState(db, await requestDeps(request), { activityId: id });
    },
  );

  app.post(
    "/api/activities/:id/grouping/stages",
    { schema: { params: ActivityParams, body: CreateGroupingStageBody } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id } = request.params as { id: string };
      const body = request.body as {
        stageKey: string;
        name: string;
        rosterSource: "all_approved" | "round_advanced";
        sourceRoundId?: string;
      };
      const outcome = await createGroupingStage(db, await requestDeps(request), {
        commandId,
        activityId: id,
        stageKey: body.stageKey,
        name: body.name,
        rosterSource: body.rosterSource,
        ...(body.sourceRoundId === undefined ? {} : { sourceRoundId: body.sourceRoundId }),
      });
      const state = await getGroupingState(db, await requestDeps(request), { activityId: id });
      const view = state.stages.find((stage) => stage.id === outcome.body.id);
      if (view === undefined) throw new DomainError("NOT_FOUND", "The grouping stage was not found.");
      return reply.status(outcome.status).send(view);
    },
  );

  app.patch(
    "/api/activities/:id/grouping/stages/:stageId/groups",
    { schema: { params: GroupingStageParams, body: RecordGroupingGroupsBody } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id, stageId } = request.params as { id: string; stageId: string };
      const body = request.body as {
        expectedRevision: number;
        groups: readonly { name?: string; participantIds: readonly string[] }[];
      };
      const outcome = await recordGroupingGroups(db, await requestDeps(request), {
        commandId,
        activityId: id,
        stageId,
        expectedRevision: body.expectedRevision,
        groups: body.groups,
      });
      const state = await getGroupingState(db, await requestDeps(request), { activityId: id });
      const view = state.stages.find((stage) => stage.id === stageId);
      if (view === undefined) throw new DomainError("NOT_FOUND", "The grouping stage was not found.");
      return reply.status(outcome.status).send(view);
    },
  );

  app.post(
    "/api/activities/:id/grouping/stages/:stageId/confirm",
    { schema: { params: GroupingStageParams, body: GroupingRevisionBody } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id, stageId } = request.params as { id: string; stageId: string };
      const body = request.body as { expectedRevision: number };
      const outcome = await confirmGroupingStage(db, await requestDeps(request), {
        commandId,
        activityId: id,
        stageId,
        expectedRevision: body.expectedRevision,
      });
      const state = await getGroupingState(db, await requestDeps(request), { activityId: id });
      const view = state.stages.find((stage) => stage.id === stageId);
      if (view === undefined) throw new DomainError("NOT_FOUND", "The grouping stage was not found.");
      return reply.status(outcome.status).send(view);
    },
  );

  app.post(
    "/api/activities/:id/grouping/stages/:stageId/freeze",
    { schema: { params: GroupingStageParams, body: GroupingRevisionBody } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id, stageId } = request.params as { id: string; stageId: string };
      const body = request.body as { expectedRevision: number };
      const outcome = await freezeGroupingStage(db, await requestDeps(request), {
        commandId,
        activityId: id,
        stageId,
        expectedRevision: body.expectedRevision,
      });
      const state = await getGroupingState(db, await requestDeps(request), { activityId: id });
      const view = state.stages.find((stage) => stage.id === stageId);
      if (view === undefined) throw new DomainError("NOT_FOUND", "The grouping stage was not found.");
      return reply.status(outcome.status).send(view);
    },
  );

  app.post(
    "/api/activities/:id/grouping/stages/:stageId/correct",
    { schema: { params: GroupingStageParams, body: CorrectGroupingBody } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id, stageId } = request.params as { id: string; stageId: string };
      const body = request.body as {
        expectedRevision: number;
        groups: readonly { name?: string; participantIds: readonly string[] }[];
        reason: string;
      };
      const outcome = await correctGroupingStage(db, await requestDeps(request), {
        commandId,
        activityId: id,
        stageId,
        expectedRevision: body.expectedRevision,
        groups: body.groups,
        reason: body.reason,
      });
      const state = await getGroupingState(db, await requestDeps(request), { activityId: id });
      const view = state.stages.find((stage) => stage.id === stageId);
      if (view === undefined) throw new DomainError("NOT_FOUND", "The grouping stage was not found.");
      return reply.status(outcome.status).send(view);
    },
  );

  app.post(
    "/api/activities/:id/grouping/stages/:stageId/cancel",
    { schema: { params: GroupingStageParams, body: CancelGroupingBody } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id, stageId } = request.params as { id: string; stageId: string };
      const body = request.body as { expectedRevision: number; reason: string };
      const outcome = await cancelGroupingStage(db, await requestDeps(request), {
        commandId,
        activityId: id,
        stageId,
        expectedRevision: body.expectedRevision,
        reason: body.reason,
      });
      const state = await getGroupingState(db, await requestDeps(request), { activityId: id });
      const view = state.stages.find((stage) => stage.id === stageId);
      if (view === undefined) throw new DomainError("NOT_FOUND", "The grouping stage was not found.");
      return reply.status(outcome.status).send(view);
    },
  );

  app.patch(
    "/api/activities/:id/grouping/stages/:stageId/window",
    { schema: { params: GroupingStageParams, body: GroupingWindowBody } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id, stageId } = request.params as { id: string; stageId: string };
      const body = request.body as {
        expectedRevision: number;
        window: "closed" | "open" | "supplement_only";
        note?: string;
      };
      const outcome = await setGroupingMaterialWindow(db, await requestDeps(request), {
        commandId,
        activityId: id,
        stageId,
        expectedRevision: body.expectedRevision,
        window: body.window,
        ...(body.note === undefined ? {} : { note: body.note }),
      });
      const state = await getGroupingState(db, await requestDeps(request), { activityId: id });
      const view = state.stages.find((stage) => stage.id === stageId);
      if (view === undefined) throw new DomainError("NOT_FOUND", "The grouping stage was not found.");
      return reply.status(outcome.status).send(view);
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

  app.post(
    "/api/activities/:id/registrations/:registrationId/account-claim",
    { schema: { params: RegistrationParams, body: Type.Object({}, { additionalProperties: false }) } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id, registrationId } = request.params as { id: string; registrationId: string };
      const outcome = await issueParticipantClaim(db, await requestDeps(request), {
        commandId,
        activityId: id,
        registrationId,
      });
      reply.header("cache-control", "no-store");
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
    "/api/activities/:id/activate",
    { schema: { params: ActivityParams, body: ActivateBody } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id } = request.params as { id: string };
      const body = request.body as { expectedRevision: number };
      const outcome = await activateActivity(db, await requireStudio(request), {
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
      const outcome = await compileDefinition(db, registry, await requireStudio(request), {
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
      const outcome = await releaseDefinitionCommand(db, registry, await requireStudio(request), {
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
      const outcome = await startExecution(db, registry, await requireSessionManager(request), {
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
      const outcome = await closeExecution(db, await requireSessionManager(request), {
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
    { schema: { params: ActivityParams }, config: { access: "operations" } },
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
    { schema: { params: ActivityParams, querystring: StateQuery }, config: { access: "operations" } },
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
    { schema: { params: ActivityParams, querystring: EventsQuery }, config: { access: "operations" } },
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

  app.post(
    "/api/activities/:id/close",
    { schema: { params: ActivityParams, body: CloseActivityBodySchema } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id } = request.params as { id: string };
      const body = request.body as { expectedRevision: number };
      const outcome = await closeActivity(db, await requestDeps(request), {
        commandId,
        activityId: id,
        expectedRevision: body.expectedRevision,
      });
      return reply.status(outcome.status).send(outcome.body);
    },
  );

  app.patch(
    "/api/activities/:id/title",
    { schema: { params: ActivityParams, body: RenameActivityBodySchema } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id } = request.params as { id: string };
      const body = request.body as { title: string; expectedRevision: number };
      const outcome = await renameActivity(db, await requestDeps(request), {
        commandId,
        activityId: id,
        title: body.title,
        expectedRevision: body.expectedRevision,
      });
      return reply.status(outcome.status).send(outcome.body);
    },
  );

  app.post(
    "/api/activities/:id/archive",
    { schema: { params: ActivityParams, body: ArchiveActivityBodySchema } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id } = request.params as { id: string };
      const body = request.body as { expectedRevision: number; note: string };
      const outcome = await archiveActivity(db, await requestDeps(request), {
        commandId,
        activityId: id,
        expectedRevision: body.expectedRevision,
        note: body.note,
      });
      return reply.status(outcome.status).send(outcome.body);
    },
  );

  app.post(
    "/api/activities/:id/unarchive",
    { schema: { params: ActivityParams, body: UnarchiveActivityBodySchema } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id } = request.params as { id: string };
      const body = request.body as { expectedRevision: number; note: string };
      const outcome = await unarchiveActivity(db, await requestDeps(request), {
        commandId,
        activityId: id,
        expectedRevision: body.expectedRevision,
        note: body.note,
      });
      return reply.status(outcome.status).send(outcome.body);
    },
  );

  app.get(
    "/api/activities/:id/archive",
    { schema: { params: ActivityParams }, config: { access: "archive" } },
    async (request) => {
      const { id } = request.params as { id: string };
      return getArchiveState(db, await requestDeps(request), { activityId: id });
    },
  );

  app.get(
    "/api/activities/:id/archive/file",
    { schema: { params: ActivityParams, querystring: ArchiveFileQuerySchema }, config: { access: "archive" } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const query = request.query as { version?: number };
      const file = await readArchiveFile(db, await requestDeps(request), {
        activityId: id,
        ...(query.version === undefined ? {} : { version: query.version }),
      });
      return reply
        .type("application/zip")
        .header("content-disposition", `attachment; filename="${file.filename}"`)
        .header("content-length", String(file.bytes.byteLength))
        .header("cache-control", "no-store")
        .send(Buffer.from(file.bytes));
    },
  );

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
