import type { Database } from "@artflow-plus/db";
import {
  findRunningSessionByScope,
  getActivityForUpdate,
  getRelease,
  getSessionForUpdate,
  insertSession,
  listRunningSessions,
  listSessionRecords,
  updateSession,
  type SessionRecord,
} from "@artflow-plus/db";
import type {
  CapabilityRegistry,
  ExecutionMode,
  ReleasedActivityDefinition,
} from "@artflow-plus/domain";
import {
  closeExecutionSession,
  DomainError,
  RUNTIME_CONTRACT_VERSION,
  startExecutionSession,
} from "@artflow-plus/domain";
import type { Kysely } from "kysely";

import { executeCommand, type CommandOutcome } from "./command.js";
import { runtimeActor, type RuntimeDeps } from "./deps.js";
import { CompositionError } from "./errors.js";
import { appendEngineEvent } from "./events.js";
import { idFromCommand } from "./hash.js";

export interface StartExecutionInput {
  readonly commandId: string;
  readonly activityId: string;
  readonly scope: string;
  readonly mode: ExecutionMode;
  readonly expectedRevision?: number;
}

export async function startExecution(
  db: Kysely<Database>,
  registry: CapabilityRegistry,
  deps: RuntimeDeps,
  input: StartExecutionInput,
): Promise<CommandOutcome<SessionRecord>> {
  return executeCommand(
    db,
    {
      commandId: input.commandId,
      activityId: input.activityId,
      capability: "engine",
      commandType: "execution.start",
      scope: input.scope,
      actor: runtimeActor(deps),
      payload: {
        scope: input.scope,
        mode: input.mode,
        expectedRevision: input.expectedRevision ?? null,
      },
    },
    async (trx) => {
      // Lock order: Activity first, then the aggregate it owns (CONC-02).
      const activity = await getActivityForUpdate(trx, input.activityId);
      if (activity === null) {
        throw new DomainError("NOT_FOUND", `Activity ${input.activityId} was not found.`);
      }
      if (
        input.expectedRevision !== undefined &&
        activity.revision !== input.expectedRevision
      ) {
        throw new DomainError("STALE_REVISION", "The activity changed since it was read.");
      }
      const release = await getRelease(
        trx,
        input.activityId,
        activity.activeDefinitionVersion,
      );
      if (release === null) {
        throw new DomainError(
          "VERSION_NOT_RELEASED",
          "Start a session only from a released definition.",
        );
      }
      const version: ReleasedActivityDefinition = {
        activityId: release.activityId,
        version: release.version,
        status: "released",
        contentHash: release.contentHash,
        capabilities: release.capabilities,
        capabilityVersions: release.capabilityVersions,
        executionPolicy: release.executionPolicy,
        bindings: release.bindings,
        releasedAt: release.releasedAt,
      };
      if (release.executionPolicy.runtimeContractVersion !== RUNTIME_CONTRACT_VERSION) {
        throw new DomainError(
          "RUNTIME_CONTRACT_MISMATCH",
          `Release ${release.version} targets runtime contract ${release.executionPolicy.runtimeContractVersion}; this build implements ${RUNTIME_CONTRACT_VERSION}.`,
        );
      }
      // The registry may only answer "do I have a compatible implementation?";
      // it may not redefine what the release means.
      for (const [identity, frozenVersion] of Object.entries(
        release.capabilityVersions,
      )) {
        const registration = registry.get(identity);
        if (
          registration === undefined ||
          registration.manifest.version !== frozenVersion
        ) {
          throw new DomainError(
            "CAPABILITY_VERSION_MISMATCH",
            `Release ${release.version} was frozen with ${identity}@${frozenVersion}, which is not the registered implementation.`,
          );
        }
      }
      if (
        release.executionPolicy.declaredScopes.length > 0 &&
        !release.executionPolicy.declaredScopes.includes(input.scope)
      ) {
        throw new DomainError(
          "SCOPE_UNDECLARED",
          `Scope ${input.scope} is not declared by release ${release.version}.`,
        );
      }
      // Migration 0003 backfills the snapshot of releases that predate it with
      // empty values. An empty snapshot has no conflicts, so trusting it would
      // silently drop the conflict policy those releases ran under; derive it
      // from the registry exactly as the pre-snapshot runtime did.
      const legacySnapshot =
        Object.keys(release.capabilityVersions).length === 0 &&
        release.executionPolicy.declaredScopes.length === 0 &&
        Object.keys(release.executionPolicy.conflicts).length === 0;
      let conflicts = release.executionPolicy.conflicts;
      if (legacySnapshot) {
        const composition = registry.validateComposition({
          enable: activity.enabledCapabilities,
        });
        if (!composition.ok) {
          throw new CompositionError(composition.issues);
        }
        conflicts = composition.plan.scopeConflicts;
      }
      const existingSessions = await listRunningSessions(trx, input.activityId);
      const openedAt = deps.now();
      const session = startExecutionSession({
        activity,
        version,
        scope: input.scope,
        mode: input.mode,
        existingSessions,
        conflicts,
        sessionId: idFromCommand("sess", input.commandId),
      });
      const saved = await insertSession(trx, session, openedAt);
      await appendEngineEvent(trx, deps, {
        type: "ExecutionSessionStarted",
        activityId: input.activityId,
        aggregateType: "execution_session",
        aggregateId: session.id,
        revision: session.revision,
        mode: session.mode,
        scope: session.scope,
        payload: {
          sessionId: session.id,
          definitionVersion: session.definitionVersion,
          contentHash: session.contentHash,
          scope: session.scope,
          mode: session.mode,
          openedAt,
        },
      });
      return { body: saved, status: 201 };
    },
  );
}

export interface CloseExecutionInput {
  readonly commandId: string;
  readonly activityId: string;
  readonly sessionId: string;
  readonly expectedRevision: number;
}

export async function closeExecution(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: CloseExecutionInput,
): Promise<CommandOutcome<SessionRecord>> {
  return executeCommand(
    db,
    {
      commandId: input.commandId,
      activityId: input.activityId,
      capability: "engine",
      commandType: "execution.close",
      actor: runtimeActor(deps),
      payload: {
        sessionId: input.sessionId,
        expectedRevision: input.expectedRevision,
      },
    },
    async (trx) => {
      const activity = await getActivityForUpdate(trx, input.activityId);
      if (activity === null) {
        throw new DomainError("NOT_FOUND", `Activity ${input.activityId} was not found.`);
      }
      const current = await getSessionForUpdate(trx, input.sessionId);
      if (current === null) {
        throw new DomainError("NOT_FOUND", `Session ${input.sessionId} was not found.`);
      }
      if (current.activityId !== input.activityId) {
        throw new DomainError("CROSS_ACTIVITY", "The session belongs to another activity.");
      }
      const closed = closeExecutionSession(current, input.expectedRevision);
      const closedAt = deps.now();
      const saved = await updateSession(trx, closed, input.expectedRevision, closedAt);
      await appendEngineEvent(trx, deps, {
        type: "ExecutionSessionClosed",
        activityId: input.activityId,
        aggregateType: "execution_session",
        aggregateId: closed.id,
        revision: closed.revision,
        mode: closed.mode,
        scope: closed.scope,
        payload: {
          sessionId: closed.id,
          closedAt,
          revision: closed.revision,
        },
      });
      return { body: saved };
    },
  );
}

export async function listExecutions(
  db: Kysely<Database>,
  activityId: string,
): Promise<readonly SessionRecord[]> {
  return listSessionRecords(db, activityId);
}

export interface RuntimeFactInput {
  readonly commandId: string;
  readonly activityId: string;
  readonly capability: string;
  readonly scope: string;
  readonly type: string;
  readonly payload: unknown;
}

export interface RuntimeFactResult {
  readonly eventId: string;
  readonly sequence: number;
  readonly mode: ExecutionMode;
  readonly scope: string;
}

const RESERVED_EVENT_PREFIXES = [
  "Activity",
  "Definition",
  "ExecutionSession",
] as const;

/**
 * The capability runtime seam: a registered capability may append a fact to a
 * running session. The mode always comes from the session, never the client.
 * This route is enabled only for the M3 skeleton proof.
 */
export async function appendRuntimeFact(
  db: Kysely<Database>,
  registry: CapabilityRegistry,
  deps: RuntimeDeps,
  input: RuntimeFactInput,
): Promise<CommandOutcome<RuntimeFactResult>> {
  return executeCommand(
    db,
    {
      commandId: input.commandId,
      activityId: input.activityId,
      capability: input.capability,
      commandType: "runtime.fact",
      scope: input.scope,
      actor: runtimeActor(deps),
      payload: { type: input.type, payload: input.payload },
    },
    async (trx) => {
      if (!/^[A-Z][A-Za-z0-9]+$/.test(input.type)) {
        throw new DomainError("INVALID_INPUT", "Fact types are CamelCase event names.");
      }
      if (RESERVED_EVENT_PREFIXES.some((prefix) => input.type.startsWith(prefix))) {
        throw new DomainError("INVALID_INPUT", `Fact type ${input.type} is reserved.`);
      }
      const registration = registry.get(input.capability);
      if (registration === undefined) {
        throw new DomainError(
          "CAPABILITY_NOT_ENABLED",
          `Capability ${input.capability} is not registered.`,
        );
      }
      const activity = await getActivityForUpdate(trx, input.activityId);
      if (activity === null) {
        throw new DomainError("NOT_FOUND", `Activity ${input.activityId} was not found.`);
      }
      if (!activity.enabledCapabilities.includes(input.capability)) {
        throw new DomainError(
          "CAPABILITY_NOT_ENABLED",
          `Capability ${input.capability} is not enabled on this activity.`,
        );
      }
      const session = await findRunningSessionByScope(
        trx,
        input.activityId,
        input.scope,
      );
      if (session === null) {
        throw new DomainError(
          "SESSION_NOT_RUNNING",
          `Scope ${input.scope} has no running execution session.`,
        );
      }
      const eventId = deps.newEventId();
      const sequence = await appendEngineEvent(trx, deps, {
        eventId,
        type: input.type,
        activityId: input.activityId,
        aggregateType: registration.manifest.identity,
        aggregateId: session.id,
        capability: input.capability,
        revision: session.revision,
        mode: session.mode,
        scope: session.scope,
        payload: input.payload,
      });
      return {
        body: {
          eventId,
          sequence,
          mode: session.mode,
          scope: session.scope,
        },
        status: 201,
      };
    },
  );
}
