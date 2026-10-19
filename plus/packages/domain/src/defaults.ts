import { competitionCapability } from "./capabilities/competition.js";
import { createCapabilityRegistry } from "./registry.js";
import type { CapabilityRegistry } from "./registry.js";

/**
 * The capabilities implemented today. Packs referencing capabilities that are
 * scheduled for M4-M7 resolve to explicit diagnostics against this registry,
 * never to half-enabled placeholders.
 */
export function createDefaultCapabilityRegistry(): CapabilityRegistry {
  const result = createCapabilityRegistry([competitionCapability]);
  if (!result.ok) {
    throw new Error(
      `The default capability registry is invalid: ${result.issues
        .map((item) => `${item.code} ${item.path}`)
        .join(", ")}`,
    );
  }
  return result.registry;
}

export const defaultCapabilityRegistry: CapabilityRegistry = createDefaultCapabilityRegistry();
