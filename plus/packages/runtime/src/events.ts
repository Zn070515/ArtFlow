import type { RuntimeEvent } from "@artflow-plus/domain";
import { appendEvent, type AppendEventInput } from "@artflow-plus/db";

import { runtimeActor, type RuntimeDeps } from "./deps.js";

export type { RuntimeEvent };

export interface EngineEventInput {
  readonly eventId?: string;
  readonly type: string;
  readonly activityId: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly revision: number;
  readonly scope?: string;
  readonly mode?: AppendEventInput["mode"];
  readonly payload: unknown;
  readonly capability?: string;
}

export async function appendEngineEvent(
  trx: Parameters<typeof appendEvent>[0],
  deps: RuntimeDeps,
  input: EngineEventInput,
): Promise<number> {
  const actor = runtimeActor(deps);
  return appendEvent(trx, {
    eventId: input.eventId ?? deps.newEventId(),
    type: input.type,
    occurredAt: deps.now(),
    activityId: input.activityId,
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    capability: input.capability ?? "engine",
    revision: input.revision,
    actorId: actor.actorId,
    actorType: actor.actorType,
    ...(input.mode === undefined ? {} : { mode: input.mode }),
    ...(input.scope === undefined ? {} : { scope: input.scope }),
    payload: input.payload,
  });
}
