import { expect } from "vitest";

import type { LifecycleContract } from "@artflow-plus/contracts";

export interface LifecycleState {
  readonly status: string;
  readonly revision: number;
}

export interface LifecycleOutcome extends LifecycleState {
  readonly replayed: boolean;
  readonly commandId: string;
}

export interface IllegalLifecycleCase {
  readonly command: string;
  readonly expectedRevision: number;
  readonly code: string;
}

export interface LifecycleAdapter {
  readonly name: string;
  readonly provider: string;
  readonly lifecycle: LifecycleContract;
  /**
   * `required` uses the template's monotonic revision. `none` lets the adapter
   * report a natural version (ticket credentialVersion) without OCC input.
   */
  readonly revisionMode: "required" | "none";
  readonly illegal: readonly IllegalLifecycleCase[];
  setup(): Promise<void>;
  execute(
    command: string,
    expectedRevision: number,
    commandId?: string,
  ): Promise<LifecycleOutcome>;
  read(): Promise<LifecycleState>;
}

/**
 * Runs one aggregate through its declared legal sequence, then attacks every
 * illegal case and asserts that neither state nor revision moved.
 */
export async function assertLifecycle(adapter: LifecycleAdapter): Promise<void> {
  await adapter.setup();
  let current: LifecycleState = { status: "none", revision: 0 };
  let revision = 0;

  for (const transition of adapter.lifecycle.transitions) {
    if (transition.from !== "none") {
      expect(current.status, `${adapter.name}: unexpected state before ${transition.command}`)
        .toBe(transition.from);
    }
    const outcome = await adapter.execute(transition.command, revision);
    expect(outcome.status, `${adapter.name}: ${transition.command} target`).toBe(transition.to);
    expect(outcome.replayed, `${adapter.name}: ${transition.command} should execute`).toBe(false);
    if (adapter.revisionMode === "required") {
      revision += transition.revisionDelta;
      expect(outcome.revision, `${adapter.name}: ${transition.command} revision`).toBe(revision);
    } else {
      revision = outcome.revision;
    }
    current = { status: outcome.status, revision };
  }

  const terminal = adapter.lifecycle.terminal[0];
  if (terminal !== undefined) {
    expect(current.status, `${adapter.name}: terminal state`).toBe(terminal);
  }

  for (const illegal of adapter.illegal) {
    const before = await adapter.read();
    await expect(
      adapter.execute(illegal.command, illegal.expectedRevision),
      `${adapter.name}: ${illegal.command} must fail with ${illegal.code}`,
    ).rejects.toMatchObject({ code: illegal.code });
    expect(await adapter.read(), `${adapter.name}: ${illegal.command} must not move state`)
      .toEqual(before);
  }
}
