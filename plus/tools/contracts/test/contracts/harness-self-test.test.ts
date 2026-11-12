import { describe, expect, it } from "vitest";

import { assertAtomicSuccess } from "../../src/harness/command.js";
import type { CommandAdapter } from "../../src/harness/command.js";
import { assertLifecycle } from "../../src/harness/lifecycle.js";
import type { LifecycleAdapter } from "../../src/harness/lifecycle.js";

/**
 * The harness must fail when a capability violates its own guarantee. These
 * deliberately broken adapters prove the assertions are not decorative.
 */
function brokenLifecycle(options: {
  readonly executeStatus?: string;
  readonly terminal?: string;
  readonly illegalShouldThrow?: boolean;
} = {}): LifecycleAdapter {
  let state = { status: "none", revision: 0 };
  return {
    name: "broken",
    provider: "broken.command",
    revisionMode: "none",
    lifecycle: {
      states: ["started", "done"],
      initial: "started",
      terminal: [options.terminal ?? "started"],
      transitions: [{ command: "go", from: "none", to: "started", revisionDelta: 0 }],
    },
    illegal: options.illegalShouldThrow === true
      ? [{ command: "go", expectedRevision: 0, code: "SHOULD_FAIL" }]
      : [],
    async setup() {
      state = { status: "none", revision: 0 };
    },
    async execute(command) {
      state = { status: options.executeStatus ?? "started", revision: 1 };
      return { ...state, replayed: false, commandId: command };
    },
    async read() {
      return state;
    },
  };
}

describe("contract harness self-test", () => {
  it("fails when a transition reaches the wrong state", async () => {
    await expect(assertLifecycle(brokenLifecycle({ executeStatus: "wrong" })))
      .rejects.toThrow("target");
  });

  it("fails when the final state is not terminal", async () => {
    await expect(assertLifecycle(brokenLifecycle({ terminal: "done" })))
      .rejects.toThrow("terminal");
  });

  it("fails when an illegal command does not throw", async () => {
    await expect(assertLifecycle(brokenLifecycle({ illegalShouldThrow: true })))
      .rejects.toThrow();
  });

  it("fails when the event count does not move atomically", async () => {
    const broken: CommandAdapter<{ readonly ok: true }> = {
      name: "broken-command",
      activityId: "activity-1",
      actor: { actorId: "actor", actorType: "user", roles: [], permissions: [] },
      commandType: "broken.command",
      capability: "broken",
      async execute() {
        return { body: { ok: true }, status: 200, replayed: false };
      },
      async countReceipts() {
        return 1;
      },
      async countAudits() {
        return 1;
      },
      async eventCount() {
        return 0;
      },
    };
    await expect(assertAtomicSuccess(broken)).rejects.toThrow("event committed");
  });
});
