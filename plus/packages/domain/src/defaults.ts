import { competitionCapability } from "./capabilities/competition.js";
import { materialsCapability } from "./capabilities/materials.js";
import { questionnaireCapability } from "./capabilities/questionnaire.js";
import { registrationCapability } from "./capabilities/registration.js";
import { votingCapability } from "./capabilities/voting.js";
import { ticketingCapability } from "./capabilities/ticketing.js";
import { publishingCapability } from "./capabilities/publishing.js";
import { archiveCapability } from "./capabilities/archive.js";
import { createCapabilityRegistry } from "./registry.js";
import type { CapabilityRegistry } from "./registry.js";

/**
 * The capabilities implemented today. Packs referencing capabilities that are
 * scheduled for M4-M7 resolve to explicit diagnostics against this registry,
 * never to half-enabled placeholders.
 */
export function createDefaultCapabilityRegistry(): CapabilityRegistry {
  const result = createCapabilityRegistry([
    competitionCapability,
    materialsCapability,
    questionnaireCapability,
    registrationCapability,
    votingCapability,
    ticketingCapability,
    publishingCapability,
    archiveCapability,
  ]);
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
