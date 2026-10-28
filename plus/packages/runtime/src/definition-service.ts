import type { Database } from "@artflow-plus/db";
import {
  getActivityForUpdate,
  getCompiled,
  getDraft,
  insertCompiled,
  insertDraft,
  insertRelease,
  listRoundsForActivity,
  listRunningSessions,
  updateActivity,
  updateDraft,
} from "@artflow-plus/db";
import type {
  ActivityDefinitionPackage,
  CapabilityRegistry,
  CompiledActivityDefinition,
  DefinitionDraft,
} from "@artflow-plus/domain";
import {
  compileActivityDefinitionPackage,
  createDefinitionDraft,
  DomainError,
  releaseDefinition,
  RUNTIME_CONTRACT_VERSION,
  updateDefinitionDraft,
} from "@artflow-plus/domain";
import type { Kysely } from "kysely";

import { executeCommand, type CommandOutcome } from "./command.js";
import { runtimeActor, type RuntimeDeps } from "./deps.js";
import { CompositionError, DefinitionInvalidError } from "./errors.js";
import { appendEngineEvent } from "./events.js";

export interface CompileDefinitionInput {
  readonly commandId: string;
  readonly activityId: string;
  readonly expectedDraftRevision?: number;
  readonly package: ActivityDefinitionPackage;
}

export interface CompileDefinitionResult {
  readonly activityId: string;
  readonly draftRevision: number;
  readonly contentHash: string;
  readonly capabilities: readonly string[];
  readonly diagnostics: readonly never[];
}

function toDomainDraft(stored: {
  activityId: string;
  revision: number;
  package: ActivityDefinitionPackage;
}): DefinitionDraft {
  return {
    activityId: stored.activityId,
    revision: stored.revision,
    status: "draft",
    package: stored.package,
  };
}

/**
 * Compile is a draft mutation: the package is validated and stored, and the
 * compiled plan is kept for the exact draft revision. Release never trusts a
 * client-supplied compiled artifact.
 */
export async function compileDefinition(
  db: Kysely<Database>,
  registry: CapabilityRegistry,
  deps: RuntimeDeps,
  input: CompileDefinitionInput,
): Promise<CommandOutcome<CompileDefinitionResult>> {
  return executeCommand(
    db,
    {
      commandId: input.commandId,
      activityId: input.activityId,
      capability: "engine",
      commandType: "definition.compile",
      actor: runtimeActor(deps),
      payload: {
        expectedDraftRevision: input.expectedDraftRevision ?? null,
        package: input.package,
      },
    },
    async (trx) => {
      const activity = await getActivityForUpdate(trx, input.activityId);
      if (activity === null) {
        throw new DomainError("NOT_FOUND", `Activity ${input.activityId} was not found.`);
      }
      // Compilation happens after the receipt claim: a replay of an accepted
      // compile never depends on the current compiler implementation.
      const compiled = compileActivityDefinitionPackage(input.package, registry.compilers);
      if (!compiled.ok) {
        throw new DefinitionInvalidError(compiled.issues);
      }
      const capabilityKeys = Object.keys(compiled.capabilities).sort();
      const stored = await getDraft(trx, input.activityId);
      let next: DefinitionDraft;
      if (stored === null) {
        if (input.expectedDraftRevision !== undefined) {
          throw new DomainError(
            "STALE_REVISION",
            "There is no draft to replace at that revision.",
          );
        }
        const base = createDefinitionDraft(activity);
        next = updateDefinitionDraft(base, base.revision, input.package);
        await insertDraft(trx, {
          activityId: next.activityId,
          revision: next.revision,
          package: next.package,
        });
      } else {
        // Revision 0 is the untouched pack default; editing it needs no token.
        if (input.expectedDraftRevision === undefined && stored.revision > 0) {
          throw new DomainError(
            "INVALID_INPUT",
            "expectedDraftRevision is required when replacing an edited draft.",
          );
        }
        next = updateDefinitionDraft(
          toDomainDraft(stored),
          input.expectedDraftRevision ?? stored.revision,
          input.package,
        );
        await updateDraft(
          trx,
          {
            activityId: next.activityId,
            revision: next.revision,
            package: next.package,
          },
          stored.revision,
        );
      }

      await insertCompiled(trx, {
        activityId: input.activityId,
        draftRevision: next.revision,
        contentHash: compiled.contentHash,
        capabilities: compiled.capabilities,
      });
      await appendEngineEvent(trx, deps, {
        type: "DefinitionCompiled",
        activityId: input.activityId,
        aggregateType: "definition_draft",
        aggregateId: input.activityId,
        revision: next.revision,
        payload: {
          activityId: input.activityId,
          draftRevision: next.revision,
          contentHash: compiled.contentHash,
          capabilities: capabilityKeys,
        },
      });

      return {
        body: {
          activityId: input.activityId,
          draftRevision: next.revision,
          contentHash: compiled.contentHash,
          capabilities: capabilityKeys,
          diagnostics: [] as const,
        },
      };
    },
  );
}

export interface ReleaseDefinitionInput {
  readonly commandId: string;
  readonly activityId: string;
  readonly expectedDraftRevision: number;
}

export interface ReleaseDefinitionResult {
  readonly activityId: string;
  readonly version: number;
  readonly contentHash: string;
}

export async function releaseDefinitionCommand(
  db: Kysely<Database>,
  registry: CapabilityRegistry,
  deps: RuntimeDeps,
  input: ReleaseDefinitionInput,
): Promise<CommandOutcome<ReleaseDefinitionResult>> {
  return executeCommand(
    db,
    {
      commandId: input.commandId,
      activityId: input.activityId,
      capability: "engine",
      commandType: "definition.release",
      actor: runtimeActor(deps),
      payload: { expectedDraftRevision: input.expectedDraftRevision },
    },
    async (trx) => {
      const activity = await getActivityForUpdate(trx, input.activityId);
      if (activity === null) {
        throw new DomainError("NOT_FOUND", `Activity ${input.activityId} was not found.`);
      }
      if ((await listRunningSessions(trx, input.activityId)).length > 0) {
        throw new DomainError("ACTIVITY_HAS_RUNNING_SESSIONS", "A definition release cannot change while an execution session is running.");
      }
      if ((await listRoundsForActivity(trx, input.activityId)).length > 0) {
        throw new DomainError(
          "ROUND_RELEASE_IMMUTABLE",
          "A definition release cannot change after a competition round has been created.",
        );
      }
      const stored = await getDraft(trx, input.activityId);
      if (stored === null) {
        throw new DomainError(
          "DEFINITION_NOT_COMPILED",
          "Compile the definition package before releasing it.",
        );
      }
      const compiled = await getCompiled(trx, input.activityId, stored.revision);
      if (compiled === null) {
        throw new DomainError(
          "DEFINITION_NOT_COMPILED",
          "The current draft revision has not been compiled.",
        );
      }
      const compiledActivity: CompiledActivityDefinition = {
        ok: true,
        contentHash: compiled.contentHash,
        capabilities: compiled.capabilities,
      };
      // Freeze the runtime meaning of this release: capability versions, the
      // declared scopes and the merged conflict policy of the enabled set.
      const composition = registry.validateComposition({
        enable: activity.enabledCapabilities,
      });
      if (!composition.ok) {
        throw new CompositionError(composition.issues);
      }
      const capabilityVersions: Record<string, string> = {};
      for (const identity of composition.plan.enabledCapabilities) {
        const registration = registry.get(identity);
        if (registration === undefined) {
          throw new CompositionError([
            {
              code: "CAPABILITY_UNKNOWN",
              message: `Capability ${identity} disappeared during release.`,
              path: `capabilities.${identity}`,
            },
          ]);
        }
        capabilityVersions[identity] = registration.manifest.version;
      }
      const executionPolicy = {
        declaredScopes: composition.plan.declaredScopes,
        conflicts: composition.plan.scopeConflicts,
        runtimeContractVersion: RUNTIME_CONTRACT_VERSION,
        commandScopes: composition.plan.commandScopes,
      };
      const result = releaseDefinition({
        activity,
        draft: toDomainDraft(stored),
        expectedDraftRevision: input.expectedDraftRevision,
        compiled: compiledActivity,
        releasedAt: deps.now(),
        executionPolicy,
        capabilityVersions,
        bindings: stored.package.bindings ?? [],
      });
      await insertRelease(trx, {
        activityId: input.activityId,
        version: result.version.version,
        contentHash: result.version.contentHash,
        capabilities: result.version.capabilities,
        executionPolicy: result.version.executionPolicy,
        capabilityVersions: result.version.capabilityVersions,
        bindings: result.version.bindings,
        releasedAt: result.version.releasedAt,
        sourceDraftRevision: stored.revision,
      });
      await updateActivity(trx, result.activity, activity.revision);
      await appendEngineEvent(trx, deps, {
        type: "DefinitionReleased",
        activityId: input.activityId,
        aggregateType: "definition_release",
        aggregateId: input.activityId,
        revision: result.version.version,
        payload: {
          activityId: input.activityId,
          version: result.version.version,
          contentHash: result.version.contentHash,
        },
      });
      return {
        body: {
          activityId: result.version.activityId,
          version: result.version.version,
          contentHash: result.version.contentHash,
        },
        status: 201,
      };
    },
  );
}
