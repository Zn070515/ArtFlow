import { randomUUID } from "node:crypto";

import { SYSTEM_ACTOR } from "@artflow-plus/domain";
import type { ActorContext } from "@artflow-plus/domain";

/** Injected clocks/ids keep tests deterministic without global state. */
export interface RuntimeDeps {
  readonly now: () => string;
  readonly newEventId: () => string;
  /**
   * The authenticated actor. M3 has no login; the API passes an explicit
   * system actor and tests inject a fixed one. Never read this from a body.
   */
  readonly actor?: ActorContext;
}

export function runtimeActor(deps: RuntimeDeps): ActorContext {
  return deps.actor ?? SYSTEM_ACTOR;
}

export function defaultRuntimeDeps(): RuntimeDeps {
  return {
    now: () => new Date().toISOString(),
    newEventId: () => randomUUID(),
    actor: SYSTEM_ACTOR,
  };
}
