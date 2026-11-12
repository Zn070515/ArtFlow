import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createCompetitionContractAdapter } from "../../src/harness/adapters/competition.js";
import { createContractClock } from "../../src/harness/clock.js";
import {
  assertActorBinding,
  assertAtomicSuccess,
  assertAuthorization,
  assertConflict,
  assertReplay,
  assertRollback,
} from "../../src/harness/command.js";
import { createContractContext, databaseUrl } from "../../src/harness/context.js";
import type { ContractContext } from "../../src/harness/context.js";
import {
  assertConcurrentCommand,
  assertRelayIdempotence,
} from "../../src/harness/fault.js";
import { assertLifecycle } from "../../src/harness/lifecycle.js";

const connectionString = databaseUrl();
const describeDb = connectionString === undefined ? describe.skip : describe;
let ctx: ContractContext | undefined;

function context(): ContractContext {
  if (ctx === undefined) throw new Error("Contract context is not initialized.");
  return ctx;
}

describeDb("competition round contract", () => {
  beforeAll(async () => {
    ctx = await createContractContext();
  });

  afterAll(async () => {
    await ctx?.dispose();
  });

  it("runs prepare, panel, scoring, lock, correction reopen, and relock", async () => {
    const adapter = createCompetitionContractAdapter(context().db, createContractClock());
    await assertLifecycle(adapter);
    expect(adapter.activityId).not.toBe("");
    expect(adapter.contestantId).not.toBe("");
  });

  it("keeps receipt, audit, and event in one transaction", async () => {
    const adapter = createCompetitionContractAdapter(context().db, createContractClock());
    await adapter.setup();
    await assertAtomicSuccess(adapter.prepareCommand);
    await assertRollback(
      context().db,
      createContractClock().deps(adapter.staff),
      adapter.activityId,
      adapter.staff,
    );
  });

  it("replays a lost prepare response without creating a second round", async () => {
    const adapter = createCompetitionContractAdapter(context().db, createContractClock());
    await adapter.setup();
    const replay = await assertReplay(adapter.prepareCommand);
    expect(replay.first.body.id).toBe(replay.replay.body.id);
  });

  it("rejects a conflicting payload", async () => {
    const adapter = createCompetitionContractAdapter(context().db, createContractClock());
    await adapter.setup();
    await assertConflict(adapter.prepareCommand, "semi");
  });

  it("binds a command id to its first actor and denies unauthorized actors", async () => {
    const binding = createCompetitionContractAdapter(context().db, createContractClock());
    await binding.setup();
    await assertActorBinding(binding.prepareCommand, binding.outsider);
    const denial = createCompetitionContractAdapter(context().db, createContractClock());
    await denial.setup();
    await assertAuthorization(denial.prepareCommand, denial.outsider);
  });

  it("serializes two concurrent identical prepare commands", async () => {
    const adapter = createCompetitionContractAdapter(context().db, createContractClock());
    await adapter.setup();
    await assertConcurrentCommand(adapter.prepareCommand);
  });

  it("applies a duplicate relay pass without advancing the projection", async () => {
    const clock = createContractClock();
    const adapter = createCompetitionContractAdapter(context().db, clock);
    await adapter.setup();
    await assertRelayIdempotence(context().db, clock.deps(adapter.staff), adapter.activityId);
  });
});
