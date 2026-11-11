import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTicketingContractAdapter } from "../../src/harness/adapters/ticketing.js";
import { createContractClock } from "../../src/harness/clock.js";
import {
  assertActorBinding,
  assertAtomicSuccess,
  assertAuthorization,
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

describeDb("ticketing command contract", () => {
  beforeAll(async () => {
    ctx = await createContractContext();
  });

  afterAll(async () => {
    await ctx?.dispose();
  });

  it("runs the ticket lifecycle and rejects terminal edges", async () => {
    const adapter = createTicketingContractAdapter(context().db, createContractClock());
    await assertLifecycle(adapter);
  });

  it("commits the ticket, receipt, audit, and event in one transaction", async () => {
    const adapter = createTicketingContractAdapter(context().db, createContractClock());
    await adapter.setup();
    await assertAtomicSuccess(adapter.issueCommand);
  });

  it("replays a lost ticket response without persisting the credential", async () => {
    const adapter = createTicketingContractAdapter(context().db, createContractClock());
    await adapter.setup();
    const replay = await assertReplay(adapter.issueCommand);
    expect(replay.first.body.credential).toEqual(expect.any(String));
    expect(replay.replay.body.credential).toBeNull();
    expect(replay.first.body.ticket.id).toBe(replay.replay.body.ticket.id);
  });

  it("enforces ticket permissions and actor-bound receipts", async () => {
    const denial = createTicketingContractAdapter(context().db, createContractClock());
    await denial.setup();
    await assertAuthorization(denial.issueCommand, denial.judge);
    const binding = createTicketingContractAdapter(context().db, createContractClock());
    await binding.setup();
    await assertActorBinding(binding.issueCommand, binding.judge);
  });

  it("replays a judge claim with a usable session token", async () => {
    const adapter = createTicketingContractAdapter(context().db, createContractClock());
    await adapter.setup();
    const first = await adapter.claim("contract-judge-claim");
    const replay = await adapter.claim("contract-judge-claim");
    expect(replay.replayed).toBe(true);
    expect(replay.body.sessionToken).toEqual(expect.any(String));
    await expect(adapter.authenticate(replay.body.sessionToken ?? ""))
      .resolves.toMatchObject({ activityId: adapter.activityId, seatId: first.body.seatId });
  });

  it("refuses ticket writes after the activity is archived", async () => {
    const adapter = createTicketingContractAdapter(context().db, createContractClock());
    await adapter.setup();
    await adapter.execute("issue", 0);
    await adapter.archive();
    await expect(adapter.execute("rotate", 0)).rejects.toMatchObject({ code: "ACTIVITY_NOT_ACTIVE" });
    await expect(adapter.execute("revoke", 0)).rejects.toMatchObject({ code: "ACTIVITY_ARCHIVED" });
  });
});
