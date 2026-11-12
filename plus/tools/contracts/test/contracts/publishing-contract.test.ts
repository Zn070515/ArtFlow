import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPublishingContractAdapter } from "../../src/harness/adapters/publishing.js";
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

describeDb("publishing release contract", () => {
  beforeAll(async () => {
    ctx = await createContractContext();
  });

  afterAll(async () => {
    await ctx?.dispose();
  });

  it("confirms, releases, revokes, re-releases, and unlocks", async () => {
    const adapter = createPublishingContractAdapter(context().db, createContractClock());
    await assertLifecycle(adapter);
    expect(adapter.activityId).not.toBe("");
  });

  it("keeps receipt, audit, and event in one transaction", async () => {
    const adapter = createPublishingContractAdapter(context().db, createContractClock());
    await adapter.setup();
    await assertAtomicSuccess(adapter.confirmCommand);
    await assertRollback(
      context().db,
      createContractClock().deps(adapter.staff),
      adapter.activityId,
      adapter.staff,
    );
  });

  it("replays a lost confirm response without creating a second stage result", async () => {
    const adapter = createPublishingContractAdapter(context().db, createContractClock());
    await adapter.setup();
    const replay = await assertReplay(adapter.confirmCommand);
    expect(replay.first.body.id).toBe(replay.replay.body.id);
  });

  it("rejects a conflicting payload", async () => {
    const adapter = createPublishingContractAdapter(context().db, createContractClock());
    await adapter.setup();
    await assertConflict(adapter.confirmCommand, [
      { award: "冠军", contestantId: "singer-a" },
    ]);
  });

  it("binds a command id to its first actor and denies unauthorized actors", async () => {
    const binding = createPublishingContractAdapter(context().db, createContractClock());
    await binding.setup();
    await assertActorBinding(binding.confirmCommand, binding.outsider);
    const denial = createPublishingContractAdapter(context().db, createContractClock());
    await denial.setup();
    await assertAuthorization(denial.confirmCommand, denial.outsider);
  });

  it("serializes two concurrent identical confirm commands", async () => {
    const adapter = createPublishingContractAdapter(context().db, createContractClock());
    await adapter.setup();
    await assertConcurrentCommand(adapter.confirmCommand);
  });

  it("applies a duplicate relay pass without advancing the projection", async () => {
    const clock = createContractClock();
    const adapter = createPublishingContractAdapter(context().db, clock);
    await adapter.setup();
    await assertRelayIdempotence(context().db, clock.deps(adapter.staff), adapter.activityId);
  });
});
