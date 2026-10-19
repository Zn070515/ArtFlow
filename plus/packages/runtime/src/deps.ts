import { randomUUID } from "node:crypto";

import { SYSTEM_ACTOR } from "@artflow-plus/domain";
import type { ActorContext } from "@artflow-plus/domain";

/** Injected clocks/ids keep tests deterministic without global state. */
export interface RuntimeDeps {
  readonly now: () => string;
  readonly newEventId: () => string;
  /** HMAC key for capability signatures; never persisted or returned. */
  readonly credentialSecret?: string;
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
  const isProduction = process.env.NODE_ENV === "production" || process.env.APP_ENV === "production";
  return {
    now: () => new Date().toISOString(),
    newEventId: () => randomUUID(),
    credentialSecret:
      process.env.ARTFLOW_PLUS_CREDENTIAL_SECRET ??
      (isProduction ? undefined : "artflow-plus-development-secret"),
    actor: SYSTEM_ACTOR,
  };
}
