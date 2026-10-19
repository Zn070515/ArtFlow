import type {
  CapabilityCompiler,
  CapabilityDefinition,
  ScopeConflictPolicy,
} from "./model.js";
import { deepFreeze } from "./model.js";

/** The four product surfaces a capability may contribute to. */
export type CapabilitySurface = "studio" | "ops" | "live" | "portal";

const SURFACES: ReadonlySet<string> = new Set(["studio", "ops", "live", "portal"]);

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
  const plan: CompositionPlan = {
    enabledCapabilities: Object.freeze(enabledList),
    scopeConflicts: deepFreeze(mergeScopeConflicts(enabledRegistrations)),
    declaredScopes: Object.freeze(declaredScopes),
  };
  return deepFreeze({ ok: true as const, plan });
}
