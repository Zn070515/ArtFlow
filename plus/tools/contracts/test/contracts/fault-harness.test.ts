import { afterAll, beforeAll, describe, it } from "vitest";

import { createRegistrationContractAdapter } from "../../src/harness/adapters/registration.js";
import { createTicketingContractAdapter } from "../../src/harness/adapters/ticketing.js";
import { createContractClock } from "../../src/harness/clock.js";
import { createContractContext, databaseUrl } from "../../src/harness/context.js";
import type { ContractContext } from "../../src/harness/context.js";
import {
  assertConcurrentCommand,
  assertRelayIdempotence,
  assertRollbackPoints,
} from "../../src/harness/fault.js";

const connectionString = databaseUrl();
const describeDb = connectionString === undefined ? describe.skip : describe;
let ctx: ContractContext | undefined;

function context(): ContractContext {
  if (ctx === undefined) throw new Error("Contract context is not initialized.");
  return ctx;
}

describeDb("shared fault harness", () => {
  beforeAll(async () => {
    ctx = await createContractContext();
  });

  afterAll(async () => {
    await ctx?.dispose();
  });

  it("rolls back every side-effect point in the registration command", async () => {
    const adapter = createRegistrationContractAdapter(context().db, createContractClock());
    await adapter.setup();
    await assertRollbackPoints(
      context().db,
      adapter.rollbackDeps(),
      adapter.activityId,
      adapter.participant,
    );
  });

  it("serializes two concurrent identical registration commands", async () => {
    const adapter = createRegistrationContractAdapter(context().db, createContractClock());
    await adapter.setup();
    await assertConcurrentCommand(adapter.startCommand);
  });

  it("does not advance the registration projection on a duplicate relay pass", async () => {
    const clock = createContractClock();
    const adapter = createRegistrationContractAdapter(context().db, clock);
    await adapter.setup();
    await assertRelayIdempotence(context().db, clock.deps(adapter.participant), adapter.activityId);
  });

  it("rolls back every side-effect point in the ticketing command", async () => {
    const adapter = createTicketingContractAdapter(context().db, createContractClock());
    await adapter.setup();
    await assertRollbackPoints(
      context().db,
      createContractClock().deps(adapter.staff),
      adapter.activityId,
      adapter.staff,
    );
  });

  it("serializes two concurrent identical ticket issues", async () => {
    const adapter = createTicketingContractAdapter(context().db, createContractClock());
    await adapter.setup();
    await assertConcurrentCommand(adapter.issueCommand);
  });
});
