import { finalizeRoster } from "@artflow-plus/runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createRegistrationContractAdapter } from "../../src/harness/adapters/registration.js";
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
import { assertLifecycle } from "../../src/harness/lifecycle.js";

const connectionString = databaseUrl();
const describeDb = connectionString === undefined ? describe.skip : describe;
let ctx: ContractContext | undefined;

function context(): ContractContext {
  if (ctx === undefined) throw new Error("Contract context is not initialized.");
  return ctx;
}

describeDb("registration command contract", () => {
  beforeAll(async () => {
    ctx = await createContractContext();
  });

  afterAll(async () => {
    await ctx?.dispose();
  });

  it("runs the declared lifecycle and rejects every illegal edge", async () => {
    const adapter = createRegistrationContractAdapter(context().db, createContractClock());
    await assertLifecycle(adapter);
    expect(adapter.activityId).not.toBe("");
  });

  it("keeps receipt, audit, and event in one transaction", async () => {
    const adapter = createRegistrationContractAdapter(context().db, createContractClock());
    await adapter.setup();
    await assertAtomicSuccess(adapter.startCommand);
    await assertRollback(context().db, adapter.rollbackDeps(), adapter.activityId, adapter.participant);
  });

  it("replays a lost response without creating a second registration", async () => {
    const adapter = createRegistrationContractAdapter(context().db, createContractClock());
    await adapter.setup();
    const replay = await assertReplay(adapter.startCommand);
    expect(replay.first.body.id).toBe(replay.replay.body.id);
    expect(replay.replay.body.status).toBe("draft");
  });

  it("rejects a conflicting payload", async () => {
    const adapter = createRegistrationContractAdapter(context().db, createContractClock());
    await adapter.setup();
    await assertConflict(adapter.startCommand, "contract-participant-2");
  });

  it("binds a command id to its first actor and denies unauthorized actors", async () => {
    const binding = createRegistrationContractAdapter(context().db, createContractClock());
    await binding.setup();
    await assertActorBinding(binding.startCommand, binding.staff);
    const denial = createRegistrationContractAdapter(context().db, createContractClock());
    await denial.setup();
    await assertAuthorization(denial.startCommand, denial.outsider);
  });

  it("freezes start, answer, and submit after a final roster", async () => {
    const clock = createContractClock();
    const adapter = createRegistrationContractAdapter(context().db, clock);
    await adapter.setup();
    await adapter.execute("start", 0);
    await adapter.execute("answer", 0);
    await adapter.execute("submit", 1);
    await adapter.execute("review", 2);
    await finalizeRoster(context().db, clock.deps(adapter.staff), {
      commandId: `contract-roster-final-${clock.newEventId()}`,
      activityId: adapter.activityId,
      expectedRevision: 0,
    });
    await expect(adapter.execute("start", 0)).rejects.toMatchObject({ code: "ROSTER_FINAL" });
    await expect(adapter.execute("answer", 0)).rejects.toMatchObject({ code: "ROSTER_FINAL" });
    await expect(adapter.execute("submit", 0)).rejects.toMatchObject({ code: "ROSTER_FINAL" });
  });
});
