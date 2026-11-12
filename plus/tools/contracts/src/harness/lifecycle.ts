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

export interface LifecycleTransition {
  readonly command: string;
  readonly from: string;
  readonly to: string;
  readonly revisionDelta: number;
}

/**
 * A second (or third) legal path for aggregates whose lifecycle branches:
 * release → revoke → re-release, or issue → rotate → revoke. Each variant runs
 * from a fresh setup so the main sequence stays readable.
 */
export interface LifecycleVariant {
  readonly name: string;
  readonly transitions: readonly LifecycleTransition[];
  readonly terminal: readonly string[];
  readonly illegal?: readonly IllegalLifecycleCase[];
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
  readonly variants?: readonly LifecycleVariant[];
  setup(): Promise<void>;
  execute(
    command: string,
    expectedRevision: number,
    commandId?: string,
  ): Promise<LifecycleOutcome>;
  read(): Promise<LifecycleState>;
}

async function runCase(
  adapter: LifecycleAdapter,
  transitions: readonly LifecycleTransition[],
  terminal: readonly string[],
  illegal: readonly IllegalLifecycleCase[],
  label: string,
): Promise<void> {
  let current: LifecycleState = { status: "none", revision: 0 };
  let revision = 0;

  for (const transition of transitions) {
    if (transition.from !== "none") {
      expect(current.status, `${label}: unexpected state before ${transition.command}`)
        .toBe(transition.from);
    }
    const outcome = await adapter.execute(transition.command, revision);
    expect(outcome.status, `${label}: ${transition.command} target`).toBe(transition.to);
    expect(outcome.replayed, `${label}: ${transition.command} should execute`).toBe(false);
    if (adapter.revisionMode === "required") {
      revision += transition.revisionDelta;
      expect(outcome.revision, `${label}: ${transition.command} revision`).toBe(revision);
    } else {
      revision = outcome.revision;
    }
    current = { status: outcome.status, revision };
  }

  if (terminal.length > 0) {
    expect(terminal, `${label}: terminal state ${current.status}`).toContain(current.status);
  }

  for (const illegalCase of illegal) {
    const before = await adapter.read();
    await expect(
      adapter.execute(illegalCase.command, illegalCase.expectedRevision),
      `${label}: ${illegalCase.command} must fail with ${illegalCase.code}`,
    ).rejects.toMatchObject({ code: illegalCase.code });
    expect(await adapter.read(), `${label}: ${illegalCase.command} must not move state`)
      .toEqual(before);
  }
}

/**
 * Runs one aggregate through its declared legal sequence, then attacks every
 * illegal case and asserts that neither state nor revision moved. Optional
 * variants each start from a fresh setup.
 */
export async function assertLifecycle(adapter: LifecycleAdapter): Promise<void> {
  await adapter.setup();
  await runCase(
    adapter,
    adapter.lifecycle.transitions,
    adapter.lifecycle.terminal,
    adapter.illegal,
    adapter.name,
  );
  for (const variant of adapter.variants ?? []) {
    await adapter.setup();
    await runCase(
      adapter,
      variant.transitions,
      variant.terminal,
      variant.illegal ?? [],
      `${adapter.name}/${variant.name}`,
    );
  }
}
