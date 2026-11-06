import { capabilityDefinitionHash } from "../compiler.js";
import type {
  CapabilityCompileResult,
  CapabilityCompiler,
  CapabilityDefinition,
  CompiledCapabilityPlan,
} from "../model.js";
import { deepFreeze } from "../model.js";
import type { CapabilityRegistration } from "../registry.js";

export interface CompiledTicketingArtifact {
  readonly schemaVersion: 1;
}

export function createEmptyTicketingDefinition(): CapabilityDefinition {
  return { schemaVersion: 1, payload: { schemaVersion: 1 } };
}

export function compileTicketingDefinition(
  definition: CapabilityDefinition,
): CapabilityCompileResult {
  if (
    definition.schemaVersion !== 1 ||
    definition.payload === null ||
    typeof definition.payload !== "object" ||
    (definition.payload as { schemaVersion?: unknown }).schemaVersion !== 1
  ) {
    return deepFreeze({
      ok: false,
      issues: [{ code: "PAYLOAD_INVALID", message: "Not a ticketing definition.", path: "payload" }],
    });
  }
  const artifact: CompiledTicketingArtifact = { schemaVersion: 1 };
  const plan: CompiledCapabilityPlan = {
    ok: true,
    capabilityKey: "ticketing",
    contentHash: capabilityDefinitionHash(definition),
    artifact: deepFreeze(artifact),
  };
  return deepFreeze(plan);
}

export const ticketingCompiler: CapabilityCompiler = {
  capabilityKey: "ticketing",
  compile: compileTicketingDefinition,
};

export const ticketingCapability: CapabilityRegistration = deepFreeze({
  manifest: {
    identity: "ticketing",
    version: "1",
    dependencies: [],
    conflicts: [],
    definitionSchemaVersion: 1,
    commands: [
      "ticketing.ticket.issue",
      "ticketing.ticket.rotate",
      "ticketing.ticket.revoke",
      "ticketing.ticket.redeem",
      "ticketing.session.revoke",
      "ticketing.judge_capability.reissue",
      "ticketing.judge_entry.close",
      "ticketing.judge_seat.claim",
    ],
    queries: ["ticketing.ticket.read", "ticketing.session.read"],
    events: [
      "TicketIssued",
      "TicketCredentialRotated",
      "TicketRevoked",
      "TicketRedeemed",
      "TicketAccessSessionRevoked",
      "JudgeCapabilityReissued",
      "JudgeEntryClosed",
      "JudgeSeatClaimed",
    ],
    permissions: ["ticket.manage", "judge.manage"],
    surfaces: ["studio", "ops", "portal", "live"],
    scopes: ["checkin", "judging"],
  },
  compiler: ticketingCompiler,
  emptyDefinition: createEmptyTicketingDefinition,
});
