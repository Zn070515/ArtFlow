import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTeamsContractAdapter } from "../../src/harness/adapters/teams.js";
import { createContractClock } from "../../src/harness/clock.js";
import { assertAuthorization } from "../../src/harness/command.js";
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

describeDb("teams command contract", () => {
  beforeAll(async () => {
    ctx = await createContractContext();
  });

  afterAll(async () => {
    await ctx?.dispose();
  });

  it("walks draft, frozen, corrected and withdrawn and rejects illegal edges", async () => {
    const adapter = createTeamsContractAdapter(context().db, createContractClock());
    await assertLifecycle(adapter);
    expect(adapter.activityId).not.toBe("");
  });

  it("denies an actor without teams.manage", async () => {
    const adapter = createTeamsContractAdapter(context().db, createContractClock());
    await adapter.setup();
    await assertAuthorization(adapter.startCommand, adapter.outsider);
  });
});
