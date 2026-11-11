import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createRegistrationContractAdapter } from "../../src/harness/adapters/registration.js";
import { createContractClock } from "../../src/harness/clock.js";
import { createContractContext, databaseUrl } from "../../src/harness/context.js";
import type { ContractContext } from "../../src/harness/context.js";

/**
 * L3 model-based lifecycle test. A small reference model describes the legal
 * registration edges; fast-check generates command sequences and the adapter
 * executes them against real PostgreSQL. The model never reads the service's
 * implementation, so a handler change that silently accepts a new edge or
 * reports the wrong revision fails here.
 */
const connectionString = databaseUrl();
const describeDb = connectionString === undefined ? describe.skip : describe;
let ctx: ContractContext | undefined;

function context(): ContractContext {
  if (ctx === undefined) throw new Error("Contract context is not initialized.");
  return ctx;
}

type State = "draft" | "submitted" | "approved";
type Command = "answer" | "submit" | "review";

interface Model {
  readonly state: State;
  readonly revision: number;
  readonly answered: boolean;
}

function apply(model: Model, command: Command): Model {
  if (command === "answer") {
    return { state: "draft", revision: model.revision + 1, answered: true };
  }
  if (command === "submit") {
    return { state: "submitted", revision: model.revision + 1, answered: model.answered };
  }
  return { state: "approved", revision: model.revision + 1, answered: model.answered };
}

function legal(model: Model, command: Command): boolean {
  if (model.state === "approved") return false;
  if (command === "answer") return model.state === "draft";
  if (command === "submit") return model.state === "draft" && model.answered;
  return model.state === "submitted";
}

const operation = fc.record({
  command: fc.constantFrom<Command>("answer", "submit", "review"),
  revision: fc.nat(6),
});

describeDb("registration lifecycle model", () => {
  beforeAll(async () => {
    ctx = await createContractContext();
  });

  afterAll(async () => {
    await ctx?.dispose();
  });

  it("matches the reference model across generated command sequences", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(operation, { maxLength: 8 }), async (operations) => {
        const adapter = createRegistrationContractAdapter(context().db, createContractClock());
        await adapter.setup();
        await adapter.execute("start", 0);
        let model: Model = { state: "draft", revision: 0, answered: false };

        for (const operation of operations) {
          if (legal(model, operation.command) && operation.revision === model.revision) {
            const outcome = await adapter.execute(operation.command, operation.revision);
            model = apply(model, operation.command);
            expect({ status: outcome.status, revision: outcome.revision }).toEqual({
              status: model.state,
              revision: model.revision,
            });
          } else {
            // The service validates required answers before the revision/state
            // transition, so an unanswered submit is INVALID_INPUT first.
            const expectedCode =
              operation.command === "submit" && !model.answered
                ? "INVALID_INPUT"
                : operation.revision !== model.revision
                  ? "STALE_REVISION"
                  : "INVALID_TRANSITION";
            await expect(adapter.execute(operation.command, operation.revision)).rejects.toMatchObject({
              code: expectedCode,
            });
          }
          expect(await adapter.read()).toEqual({ status: model.state, revision: model.revision });
        }
      }),
      { numRuns: 30 },
    );
  }, 60_000);
});
