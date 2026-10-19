import { randomUUID } from "node:crypto";

/** Injected clocks/ids keep tests deterministic without global state. */
export interface RuntimeDeps {
  readonly now: () => string;
  readonly newEventId: () => string;
}

export function defaultRuntimeDeps(): RuntimeDeps {
  return {
    now: () => new Date().toISOString(),
    newEventId: () => randomUUID(),
  };
}
