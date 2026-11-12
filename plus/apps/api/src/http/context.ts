import type { Database, StoredLocalSession, StoredRound } from "@artflow-plus/db";
import type {
  ActivityPack,
  ActorContext,
  CapabilityRegistry,
} from "@artflow-plus/domain";
import type { DocumentExporter, RateLimiter, RuntimeDeps } from "@artflow-plus/runtime";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";

export type ReadAccess =
  | "public"
  | "session"
  | "operations"
  | "analytics"
  | "studio"
  | "tasks"
  | "voting"
  | "result"
  | "archive";

/**
 * Everything a route module may use. `app.ts` owns construction, the fail-closed
 * `onRoute` hook, CSRF, error mapping, and the realtime server; modules only
 * register routes against these already-scoped dependencies.
 */
export interface ApiContext {
  readonly app: FastifyInstance;
  readonly db: Kysely<Database>;
  readonly deps: RuntimeDeps;
  readonly baseDeps: RuntimeDeps;
  readonly registry: CapabilityRegistry;
  readonly packs: readonly ActivityPack[];
  readonly rateLimiter: RateLimiter;
  readonly documentExporter: DocumentExporter | null;
  readonly isProduction: boolean;
  readonly sessionSecret: string;
  readonly enableRuntimeFacts: boolean;

  readonly setSessionCookies: (reply: FastifyReply, token: string, csrf: string) => void;
  readonly clearSessionCookies: (reply: FastifyReply) => void;
  readonly publicActor: (actor: ActorContext) => ActorContext;
  readonly requestSession: (request: FastifyRequest) => Promise<StoredLocalSession | null>;
  readonly requestActor: (request: FastifyRequest) => Promise<ActorContext>;
  readonly requestDeps: (request: FastifyRequest) => Promise<RuntimeDeps>;
  readonly requireStudio: (request: FastifyRequest) => Promise<RuntimeDeps>;
  readonly requireOperationsReader: (request: FastifyRequest) => Promise<void>;
  readonly requireReadAccess: (request: FastifyRequest, access: ReadAccess) => Promise<void>;
  readonly requireSessionManager: (request: FastifyRequest) => Promise<RuntimeDeps>;
  readonly publicDeps: () => RuntimeDeps;
  readonly judgeScoreDeps: (request: FastifyRequest) => Promise<RuntimeDeps>;
  readonly requireRateLimit: (key: string, limit: number) => Promise<void>;
  readonly requirePublicRateLimit: (
    request: FastifyRequest,
    key: string,
    limit: number,
  ) => Promise<void>;
  readonly routeRound: (activityId: string, roundKey: string) => Promise<StoredRound>;
}
