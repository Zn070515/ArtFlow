import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createVotingContractAdapter } from "../../src/harness/adapters/voting.js";
import { createContractClock } from "../../src/harness/clock.js";
import {
  assertActorBinding,
  assertAtomicSuccess,
  assertAuthorization,
  assertConflict,
  assertReplay,
} from "../../src/harness/command.js";
import { createContractContext, databaseUrl } from "../../src/harness/context.js";
import type { ContractContext } from "../../src/harness/context.js";
import { assertLifecycle } from "../../src/harness/lifecycle.js";

const connectionString = databaseUrl();
const describeDb = connectionString === undefined ? describe.skip : describe;
let ctx: ContractContext | undefined;

function context(): ContractContext {
  if (ctx === undefined) throw new Error("Contract context is not initialized.");
  return ctx;
}

describeDb("voting command contract", () => {
  beforeAll(async () => {
    ctx = await createContractContext();
  });

  afterAll(async () => {
    await ctx?.dispose();
  });

  it("runs the vote-session lifecycle and rejects terminal edges", async () => {
    const adapter = createVotingContractAdapter(context().db, createContractClock());
    await assertLifecycle(adapter);
  });

  it("commits the vote session, receipt, audit, and event in one transaction", async () => {
    const adapter = createVotingContractAdapter(context().db, createContractClock());
    await adapter.setup();
    await assertAtomicSuccess(adapter.openCommand);
  });

  it("replays a lost open response without creating a second session", async () => {
    const adapter = createVotingContractAdapter(context().db, createContractClock());
    await adapter.setup();
    const replay = await assertReplay(adapter.openCommand);
    expect(replay.first.body.session.status).toBe("open");
    expect(replay.replay.body.session.revision).toBe(replay.first.body.session.revision);
  });

  it("rejects the same command id with a different candidate payload", async () => {
    const adapter = createVotingContractAdapter(context().db, createContractClock());
    await adapter.setup();
    await assertConflict(adapter.openCommand, { candidateIds: ["candidate-c"] });
  });

  it("enforces voting.manage and actor-bound receipts", async () => {
    const denial = createVotingContractAdapter(context().db, createContractClock());
    await denial.setup();
    await assertAuthorization(denial.openCommand, denial.viewer);
    const binding = createVotingContractAdapter(context().db, createContractClock());
    await binding.setup();
    await assertActorBinding(binding.openCommand, binding.viewer);
  });

  it("rejects a second ballot from the same browser identity", async () => {
    const adapter = createVotingContractAdapter(context().db, createContractClock());
    await adapter.setup();
    await adapter.execute("open", 0);
    await adapter.submit("contract-vote-ballot-1", "fingerprint-1");
    await expect(adapter.submit("contract-vote-ballot-2", "fingerprint-1"))
      .rejects.toMatchObject({ code: "DUPLICATE_BALLOT" });
    expect(await adapter.ballotCount()).toBe(1);
  });

  it("rejects a ballot after the execution release changes", async () => {
    const adapter = createVotingContractAdapter(context().db, createContractClock());
    await adapter.setup();
    await adapter.execute("open", 0);
    await adapter.staleRelease();
    await expect(adapter.submit("contract-vote-ballot-stale", "fingerprint-2"))
      .rejects.toMatchObject({ code: "STALE_CONTEXT" });
  });

  it("rejects a ballot after the execution mode changes", async () => {
    const adapter = createVotingContractAdapter(context().db, createContractClock());
    await adapter.setup();
    await adapter.execute("open", 0);
    await adapter.modeChanged("test");
    await expect(adapter.submit("contract-vote-ballot-mode", "fingerprint-3"))
      .rejects.toMatchObject({ code: "STALE_CONTEXT" });
  });
});
