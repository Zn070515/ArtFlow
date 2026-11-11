import { randomUUID } from "node:crypto";

import type { ActorContext } from "@artflow-plus/domain";
import type { RuntimeDeps } from "@artflow-plus/runtime";

export interface ContractClock {
  now(): string;
  newEventId(): string;
  deps(actor: ActorContext, credentialSecret?: string): RuntimeDeps;
}

/**
 * A deterministic clock. Contract cases must not depend on wall-clock time or
 * random sleeps; callers advance it by executing commands.
 */
export function createContractClock(
  start = Date.UTC(2026, 10, 11, 12, 0, 0),
): ContractClock {
  let tick = 0;
  const now = (): string => new Date(start + tick++ * 1000).toISOString();
  return {
    now,
    newEventId: () => randomUUID(),
    deps(actor: ActorContext, credentialSecret?: string): RuntimeDeps {
      return {
        actor,
        now: () => new Date(start + tick++ * 1000).toISOString(),
        newEventId: () => randomUUID(),
        ...(credentialSecret === undefined ? {} : { credentialSecret }),
      };
    },
  };
}
