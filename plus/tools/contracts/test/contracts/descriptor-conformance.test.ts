import { ContractDescriptorSchema } from "@artflow-plus/contracts";
import { defaultCapabilityRegistry } from "@artflow-plus/domain";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { COMPETITION_CONTRACT_DESCRIPTOR } from "../../src/harness/adapters/competition.js";
import { PUBLISHING_CONTRACT_DESCRIPTOR } from "../../src/harness/adapters/publishing.js";
import { REGISTRATION_CONTRACT_DESCRIPTOR } from "../../src/harness/adapters/registration.js";
import { TICKETING_CONTRACT_DESCRIPTOR } from "../../src/harness/adapters/ticketing.js";

const DESCRIPTORS = [
  COMPETITION_CONTRACT_DESCRIPTOR,
  PUBLISHING_CONTRACT_DESCRIPTOR,
  REGISTRATION_CONTRACT_DESCRIPTOR,
  TICKETING_CONTRACT_DESCRIPTOR,
];

describe("contract descriptors", () => {
  it("matches the shared descriptor schema", () => {
    for (const descriptor of DESCRIPTORS) {
      expect(Value.Check(ContractDescriptorSchema, descriptor), descriptor.id).toBe(true);
    }
  });

  it("names a registered capability and a command that capability declares", () => {
    for (const descriptor of DESCRIPTORS) {
      const capability = defaultCapabilityRegistry.get(descriptor.id);
      expect(capability, `${descriptor.id} is not a registered capability`).toBeDefined();
      expect(capability?.manifest.commands, descriptor.id).toContain(descriptor.provider);
    }
  });

  it("keeps ids unique and carries executable expectations", () => {
    expect(new Set(DESCRIPTORS.map((descriptor) => descriptor.id)).size).toBe(DESCRIPTORS.length);
    for (const descriptor of DESCRIPTORS) {
      expect(descriptor.consumers.length, descriptor.id).toBeGreaterThan(0);
      expect(descriptor.invariants.length, descriptor.id).toBeGreaterThan(0);
      expect(descriptor.errors.length, descriptor.id).toBeGreaterThan(0);
      expect(descriptor.idempotency.length, descriptor.id).toBeGreaterThan(20);
      expect(descriptor.recovery.length, descriptor.id).toBeGreaterThan(20);
    }
  });
});
