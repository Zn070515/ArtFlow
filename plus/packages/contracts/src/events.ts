import { Type, type Static } from "@sinclair/typebox";

import { ExecutionModeSchema } from "./common.js";

/** The transport shape of a domain event; events are immutable facts. */
export const DomainEventEnvelopeSchema = Type.Object(
  {
    eventId: Type.String({ minLength: 1, maxLength: 100 }),
    type: Type.String({ pattern: "^[A-Z][A-Za-z0-9]+$", maxLength: 100 }),
    occurredAt: Type.String({ minLength: 1, maxLength: 40 }),
    activityId: Type.String({ minLength: 1, maxLength: 100 }),
    capability: Type.String({ minLength: 1, maxLength: 100 }),
    aggregateId: Type.String({ minLength: 1, maxLength: 100 }),
    revision: Type.Integer({ minimum: 0 }),
    mode: Type.Optional(ExecutionModeSchema),
    scope: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
    payload: Type.Unknown(),
  },
  { additionalProperties: false },
);

export type DomainEventEnvelope = Static<typeof DomainEventEnvelopeSchema>;
