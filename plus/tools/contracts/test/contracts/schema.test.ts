import {
  AuthorizationContractSchema,
  ContractDescriptorSchema,
  IdempotencyContractSchema,
  LifecycleContractSchema,
  RecoveryContractSchema,
  TransactionContractSchema,
} from "@artflow-plus/contracts";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

describe("contract descriptors", () => {
  it("accepts a well-formed command descriptor", () => {
    const descriptor = {
      id: "registration.command",
      version: 1,
      kind: "idempotency",
      provider: "executeCommand",
      consumers: ["registration.start", "registration.answer"],
      preconditions: ["activity is active", "registration lifecycle is open"],
      outputs: ["stored registration", "command receipt"],
      invariants: ["one receipt per command id", "one event per accepted command"],
      errors: ["COMMAND_ID_CONFLICT", "STALE_REVISION"],
      sideEffects: ["receipt", "audit", "outbox"],
      idempotency: "same command id and payload replays the stored receipt",
      concurrency: "duplicate retries serialize on the receipt unique index",
      recovery: "retry the same command id; the receipt is the recovery authority",
    };
    expect(Value.Check(ContractDescriptorSchema, descriptor)).toBe(true);
    expect(Value.Check(ContractDescriptorSchema, { ...descriptor, kind: "unknown" })).toBe(false);
    expect(Value.Check(ContractDescriptorSchema, { ...descriptor, consumers: [] })).toBe(false);
  });

  it("validates the small orthogonal policies", () => {
    expect(Value.Check(LifecycleContractSchema, {
      states: ["draft", "submitted", "approved"],
      initial: "draft",
      terminal: ["approved"],
      transitions: [
        { command: "submit", from: "draft", to: "submitted", revisionDelta: 1 },
      ],
    })).toBe(true);
    expect(Value.Check(IdempotencyContractSchema, {
      commandIdField: "commandId",
      replay: "receipt",
      conflict: "reject",
      actorBound: true,
    })).toBe(true);
    expect(Value.Check(AuthorizationContractSchema, {
      permissions: ["registration.manage"],
      actorRequired: true,
    })).toBe(true);
    expect(Value.Check(TransactionContractSchema, {
      atomicWrites: ["receipt", "audit", "fact", "outbox"],
      sideEffects: ["outbox"],
      rollbackOnError: true,
    })).toBe(true);
    expect(Value.Check(RecoveryContractSchema, {
      retry: "same-command-id",
      responseLoss: "replay-receipt",
      finalState: "registration draft",
    })).toBe(true);
    expect(Value.Check(RecoveryContractSchema, {
      retry: "new-command-id",
      responseLoss: "replay-receipt",
      finalState: "registration draft",
    })).toBe(false);
  });
});
