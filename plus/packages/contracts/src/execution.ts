import { Type, type Static } from "@sinclair/typebox";

import { ExecutionModeSchema } from "./common.js";
import { DomainEventEnvelopeSchema } from "./events.js";

export const StartExecutionBodySchema = Type.Object(
  {
    scope: Type.String({ pattern: "^[a-z][a-z0-9_-]*$", maxLength: 100 }),
    mode: ExecutionModeSchema,
    expectedRevision: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

export const CloseExecutionBodySchema = Type.Object(
  { expectedRevision: Type.Integer({ minimum: 0 }) },
  { additionalProperties: false },
);

export const ExecutionSessionSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 100 }),
    activityId: Type.String({ minLength: 1, maxLength: 100 }),
    definitionVersion: Type.Integer({ minimum: 1 }),
    contentHash: Type.String({ minLength: 1, maxLength: 128 }),
    scope: Type.String({ minLength: 1, maxLength: 100 }),
    mode: ExecutionModeSchema,
    status: Type.Union([Type.Literal("running"), Type.Literal("closed")]),
    revision: Type.Integer({ minimum: 0 }),
    openedAt: Type.String({ minLength: 1, maxLength: 40 }),
    closedAt: Type.Optional(Type.String({ minLength: 1, maxLength: 40 })),
  },
  { additionalProperties: false },
);

export const ExecutionProjectionSchema = Type.Object(
  {
    activityId: Type.String({ minLength: 1, maxLength: 100 }),
    mode: ExecutionModeSchema,
    sessions: Type.Record(Type.String(), ExecutionSessionSchema),
    runningScopes: Type.Array(Type.String()),
    lastSequence: Type.Integer({ minimum: 0 }),
    headSequence: Type.Integer({ minimum: 0 }),
    stale: Type.Boolean(),
    status: Type.Union([Type.Literal("running"), Type.Literal("blocked")]),
    blockedSequence: Type.Optional(Type.Integer({ minimum: 0 })),
    blockedReason: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const EventFeedSchema = Type.Object(
  {
    events: Type.Array(DomainEventEnvelopeSchema),
    nextCursor: Type.Integer({ minimum: 0 }),
    headCursor: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export type StartExecutionBody = Static<typeof StartExecutionBodySchema>;
export type CloseExecutionBody = Static<typeof CloseExecutionBodySchema>;
export type ExecutionSessionContract = Static<typeof ExecutionSessionSchema>;
export type ExecutionProjectionContract = Static<typeof ExecutionProjectionSchema>;
export type EventFeed = Static<typeof EventFeedSchema>;
