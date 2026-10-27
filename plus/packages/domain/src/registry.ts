import type {
  CapabilityCompiler,
  CapabilityDefinition,
  ScopeConflictPolicy,
} from "./model.js";
import { deepFreeze } from "./model.js";

/** The four product surfaces a capability may contribute to. */
export type CapabilitySurface = "studio" | "ops" | "live" | "portal";

const SURFACES: ReadonlySet<string> = new Set(["studio", "ops", "live", "portal"]);
/** Same contract as CapabilityManifestSchema.scopes and StartExecutionBody. */
const SCOPE_PATTERN = /^[a-z][a-z0-9_-]*$/;
const SCOPE_MAX_LENGTH = 100;

/**
 * What a capability declares about itself (roadmap M2, ADR-0009). The manifest
 * is composition metadata only: it never describes how the capability works.
 */
export interface CapabilityManifest {
  readonly identity: string;
  readonly version: string;
  readonly dependencies: readonly string[];
  readonly conflicts: readonly string[];
  readonly definitionSchemaVersion: number;
  readonly commands: readonly string[];
  readonly queries: readonly string[];
  readonly events: readonly string[];
  readonly permissions: readonly string[];
  readonly surfaces: readonly CapabilitySurface[];
  /**
   * Execution scopes this capability owns. A release freezes their union; a
   * session may only use a declared scope when at least one capability
   * declared scopes. Empty means "not specified yet" during migration.
   */
  readonly scopes?: readonly string[];
  /**
   * Execution-scoped commands owned by this capability and the scopes each may
   * run in. Commands absent from this map are activity-scoped, not session
   * commands. The composition freezes the merged map into the release.
   */
  readonly commandScopes?: Readonly<Record<string, readonly string[]>>;
}

/**
 * A capability's contribution to the registry. `emptyDefinition` is the
 * unconfigured shape a Pack can compile without asking the organizer anything;
 * it must not be a placeholder that the capability's own compiler refuses.
 */
export interface CapabilityRegistration {
  readonly manifest: CapabilityManifest;
  readonly compiler: CapabilityCompiler;
  readonly emptyDefinition: () => CapabilityDefinition;
  /** Scope conflicts contributed by this capability to the composition. */
  readonly scopeConflicts?: ScopeConflictPolicy;
}

export interface RegistryIssue {
  readonly code: string;
  readonly message: string;
  readonly path: string;
}

export interface CompositionRequest {
  readonly enable: readonly string[];
  readonly disable?: readonly string[];
}

export interface CompositionPlan {
  /** The dependency-closed, sorted set that may be enabled together. */
  readonly enabledCapabilities: readonly string[];
  /** The merged scope conflict policy of the enabled capabilities. */
  readonly scopeConflicts: ScopeConflictPolicy;
  /** The sorted union of scopes declared by the enabled capabilities. */
  readonly declaredScopes: readonly string[];
  /** The merged command → allowed scopes map, frozen into the release. */
  readonly commandScopes: Readonly<Record<string, readonly string[]>>;
}

export type CompositionResult =
  | { readonly ok: true; readonly plan: CompositionPlan }
  | { readonly ok: false; readonly issues: readonly RegistryIssue[] };

export interface CapabilityRegistry {
  /** Every registered capability, sorted by identity. */
  list(): readonly CapabilityRegistration[];
  get(identity: string): CapabilityRegistration | undefined;
  /** Compilers for the Activity compiler, sorted by identity. */
  readonly compilers: readonly CapabilityCompiler[];
  validateComposition(request: CompositionRequest): CompositionResult;
}

export type CapabilityRegistryResult =
  | { readonly ok: true; readonly registry: CapabilityRegistry }
  | { readonly ok: false; readonly issues: readonly RegistryIssue[] };

function issue(code: string, message: string, path: string): RegistryIssue {
  return { code, message, path };
}

function mergeScopeConflicts(
  registrations: readonly CapabilityRegistration[],
): ScopeConflictPolicy {
  const merged = new Map<string, Set<string>>();
  for (const registration of registrations) {
    for (const [scope, conflicts] of Object.entries(registration.scopeConflicts ?? {})) {
      const target = merged.get(scope) ?? new Set<string>();
      for (const conflict of conflicts) target.add(conflict);
      merged.set(scope, target);
    }
  }
  const policy: Record<string, readonly string[]> = {};
  for (const scope of [...merged.keys()].sort()) {
    policy[scope] = [...(merged.get(scope) ?? new Set<string>())].sort();
  }
  return policy;
}

function mergeCommandScopes(
  registrations: readonly CapabilityRegistration[],
  declaredScopes: readonly string[],
  record: (value: RegistryIssue) => void,
): Readonly<Record<string, readonly string[]>> {
  const merged = new Map<string, { owner: string; scopes: Set<string> }>();
  for (const registration of registrations) {
    const identity = registration.manifest.identity;
    const commands = new Set(registration.manifest.commands);
    const ownScopes = new Set(registration.manifest.scopes ?? []);
    for (const [command, scopes] of Object.entries(registration.manifest.commandScopes ?? {})) {
      if (!commands.has(command)) {
        record(issue(
          "COMMAND_SCOPE_UNKNOWN_COMMAND",
          `Capability ${identity} binds a command it does not declare: ${command}.`,
          `capabilities.${identity}.commandScopes.${command}`,
        ));
        continue;
      }
      if (!Array.isArray(scopes) || scopes.length === 0) {
        record(issue(
          "COMMAND_SCOPE_EMPTY",
          `Command ${command} must bind at least one execution scope.`,
          `capabilities.${identity}.commandScopes.${command}`,
        ));
        continue;
      }
      const invalid = scopes.filter(
        (scope) => !ownScopes.has(scope) || !declaredScopes.includes(scope),
      );
      if (invalid.length > 0) {
        record(issue(
          "COMMAND_SCOPE_UNDECLARED",
          `Command ${command} binds scopes the capability does not declare: ${invalid.join(", ")}.`,
          `capabilities.${identity}.commandScopes.${command}`,
        ));
        continue;
      }
      const existing = merged.get(command);
      if (existing !== undefined && existing.owner !== identity) {
        record(issue(
          "COMMAND_SCOPE_CONFLICT",
          `Command ${command} is claimed by both ${existing.owner} and ${identity}.`,
          `capabilities.${identity}.commandScopes.${command}`,
        ));
        continue;
      }
      const target = existing ?? { owner: identity, scopes: new Set<string>() };
      for (const scope of scopes) target.scopes.add(scope);
      merged.set(command, target);
    }
  }
  const policy: Record<string, readonly string[]> = {};
  for (const command of [...merged.keys()].sort()) {
    policy[command] = [...(merged.get(command)?.scopes ?? new Set<string>())].sort();
  }
  return policy;
}

/**
 * Builds a registry from capability modules. Invalid composition metadata is a
 * programming error: it is reported here, at assembly time, never at run time.
 */
export function createCapabilityRegistry(
  registrations: readonly CapabilityRegistration[],
): CapabilityRegistryResult {
  const issues: RegistryIssue[] = [];
  const byIdentity = new Map<string, CapabilityRegistration>();

  for (const registration of registrations) {
    const { manifest } = registration;
    const path = `capabilities.${manifest.identity}`;
    if (!manifest.identity.trim()) {
      issues.push(issue("CAPABILITY_IDENTITY", "A capability needs an identity.", path));
      continue;
    }
    if (!manifest.version.trim()) {
      issues.push(issue("CAPABILITY_VERSION", "A capability needs a version.", path));
      continue;
    }
    if (byIdentity.has(manifest.identity)) {
      issues.push(
        issue(
          "CAPABILITY_DUPLICATE",
          `Capability ${manifest.identity} is registered more than once.`,
          path,
        ),
      );
      continue;
    }
    if (registration.compiler.capabilityKey !== manifest.identity) {
      issues.push(
        issue(
          "CAPABILITY_COMPILER_MISMATCH",
          `Capability ${manifest.identity} has a compiler for ${registration.compiler.capabilityKey}.`,
          `${path}.compiler`,
        ),
      );
    }
    if (manifest.definitionSchemaVersion < 1) {
      issues.push(
        issue(
          "CAPABILITY_DEFINITION_VERSION",
          `Capability ${manifest.identity} needs a definitionSchemaVersion of at least 1.`,
          `${path}.definitionSchemaVersion`,
        ),
      );
    }
    if (manifest.surfaces.length === 0) {
      issues.push(
        issue(
          "CAPABILITY_SURFACES",
          `Capability ${manifest.identity} needs at least one product surface.`,
          `${path}.surfaces`,
        ),
      );
    }
    for (const surface of manifest.surfaces) {
      if (!SURFACES.has(surface)) {
        issues.push(
          issue(
            "CAPABILITY_SURFACE",
            `Capability ${manifest.identity} declares unknown surface ${surface}.`,
            `${path}.surfaces`,
          ),
        );
      }
    }
    const scopes = manifest.scopes ?? [];
    if (new Set(scopes).size !== scopes.length) {
      issues.push(
        issue(
          "CAPABILITY_SCOPE",
          `Capability ${manifest.identity} declares duplicate scopes.`,
          `${path}.scopes`,
        ),
      );
    }
    for (const scope of scopes) {
      if (
        scope.length === 0 ||
        scope.length > SCOPE_MAX_LENGTH ||
        !SCOPE_PATTERN.test(scope)
      ) {
        issues.push(
          issue(
            "CAPABILITY_SCOPE",
            `Capability ${manifest.identity} declares invalid scope ${scope}.`,
            `${path}.scopes`,
          ),
        );
      }
    }
    if (manifest.dependencies.includes(manifest.identity)) {
      issues.push(
        issue(
          "CAPABILITY_SELF_REFERENCE",
          `Capability ${manifest.identity} depends on itself.`,
          `${path}.dependencies`,
        ),
      );
    }
    if (manifest.conflicts.includes(manifest.identity)) {
      issues.push(
        issue(
          "CAPABILITY_SELF_REFERENCE",
          `Capability ${manifest.identity} conflicts with itself.`,
          `${path}.conflicts`,
        ),
      );
    }
    for (const dependency of manifest.dependencies) {
      if (manifest.conflicts.includes(dependency)) {
        issues.push(
          issue(
            "CAPABILITY_DEPENDENCY_CONFLICT",
            `Capability ${manifest.identity} both depends on and conflicts with ${dependency}.`,
            `${path}.conflicts`,
          ),
        );
      }
    }
    byIdentity.set(manifest.identity, deepFreeze(registration));
  }

  for (const registration of byIdentity.values()) {
    for (const dependency of registration.manifest.dependencies) {
      if (!byIdentity.has(dependency)) {
        issues.push(
          issue(
            "CAPABILITY_DEPENDENCY_UNKNOWN",
            `Capability ${registration.manifest.identity} depends on unregistered ${dependency}.`,
            `capabilities.${registration.manifest.identity}.dependencies`,
          ),
        );
      }
    }
  }

  if (issues.length > 0) {
    return deepFreeze({ ok: false as const, issues: Object.freeze(issues) });
  }

  const sorted = Object.freeze(
    [...byIdentity.values()].sort((left, right) =>
      left.manifest.identity < right.manifest.identity ? -1 : 1,
    ),
  );
  const compilers = Object.freeze(sorted.map((registration) => registration.compiler));

  const registry: CapabilityRegistry = {
    list: () => sorted,
    get: (identity) => byIdentity.get(identity),
    compilers,
    validateComposition(request): CompositionResult {
      return validateComposition(byIdentity, request);
    },
  };
  return deepFreeze({ ok: true as const, registry });
}

function validateComposition(
  byIdentity: ReadonlyMap<string, CapabilityRegistration>,
  request: CompositionRequest,
): CompositionResult {
  const issues: RegistryIssue[] = [];
  const seenIssues = new Set<string>();
  const record = (item: RegistryIssue): void => {
    const key = `${item.code}|${item.path}|${item.message}`;
    if (seenIssues.has(key)) return;
    seenIssues.add(key);
    issues.push(item);
  };

  const disabled = new Set(request.disable ?? []);
  for (const identity of disabled) {
    if (!byIdentity.has(identity)) {
      record(
        issue(
          "CAPABILITY_UNKNOWN",
          `Composition names unknown capability ${identity}.`,
          `capabilities.${identity}`,
        ),
      );
    }
  }

  const enabled = new Set<string>();
  const queue = [...new Set(request.enable)].sort();
  while (queue.length > 0) {
    const identity = queue.shift();
    if (identity === undefined) break;
    if (enabled.has(identity)) continue;
    if (disabled.has(identity)) {
      record(
        issue(
          "CAPABILITY_DEPENDENCY_DISABLED",
          `Capability ${identity} is required but was disabled.`,
          `capabilities.${identity}`,
        ),
      );
      continue;
    }
    const registration = byIdentity.get(identity);
    if (registration === undefined) {
      record(
        issue(
          "CAPABILITY_UNKNOWN",
          `Composition names unknown capability ${identity}.`,
          `capabilities.${identity}`,
        ),
      );
      continue;
    }
    enabled.add(identity);
    for (const dependency of registration.manifest.dependencies) {
      if (disabled.has(dependency)) {
        record(
          issue(
            "CAPABILITY_DEPENDENCY_DISABLED",
            `Capability ${identity} depends on disabled ${dependency}.`,
            `capabilities.${dependency}`,
          ),
        );
        continue;
      }
      queue.push(dependency);
    }
    queue.sort();
  }

  const enabledList = [...enabled].sort();
  for (let left = 0; left < enabledList.length; left += 1) {
    for (let right = left + 1; right < enabledList.length; right += 1) {
      const leftIdentity = enabledList[left];
      const rightIdentity = enabledList[right];
      if (leftIdentity === undefined || rightIdentity === undefined) continue;
      const leftRegistration = byIdentity.get(leftIdentity);
      const rightRegistration = byIdentity.get(rightIdentity);
      if (leftRegistration === undefined || rightRegistration === undefined) continue;
      if (
        leftRegistration.manifest.conflicts.includes(rightIdentity) ||
        rightRegistration.manifest.conflicts.includes(leftIdentity)
      ) {
        record(
          issue(
            "CAPABILITY_CONFLICT",
            `Capabilities ${leftIdentity} and ${rightIdentity} cannot be enabled together.`,
            `capabilities.${leftIdentity}`,
          ),
        );
      }
    }
  }

  if (issues.length > 0) {
    return deepFreeze({ ok: false as const, issues: Object.freeze(issues) });
  }

  const enabledRegistrations = enabledList
    .map((identity) => byIdentity.get(identity))
    .filter((item): item is CapabilityRegistration => item !== undefined);
  const declaredScopes = [
    ...new Set(enabledRegistrations.flatMap((item) => item.manifest.scopes ?? [])),
  ].sort();
  const commandScopes = mergeCommandScopes(enabledRegistrations, declaredScopes, record);
  if (issues.length > 0) {
    return deepFreeze({ ok: false as const, issues: Object.freeze(issues) });
  }
  const plan: CompositionPlan = {
    enabledCapabilities: Object.freeze(enabledList),
    scopeConflicts: deepFreeze(mergeScopeConflicts(enabledRegistrations)),
    declaredScopes: Object.freeze(declaredScopes),
    commandScopes: deepFreeze(commandScopes),
  };
  return deepFreeze({ ok: true as const, plan });
}
