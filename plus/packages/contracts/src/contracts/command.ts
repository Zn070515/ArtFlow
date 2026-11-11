import { Type, type Static } from "@sinclair/typebox";

/** The command receipt is the only replay authority; conflicts are rejected. */
export const IdempotencyContractSchema = Type.Object(
  {
    commandIdField: Type.Literal("commandId"),
    replay: Type.Literal("receipt"),
    conflict: Type.Literal("reject"),
    actorBound: Type.Boolean(),
  },
  { additionalProperties: false },
);

/** Mutations are authorized by permission and, when scoped, a frozen scope. */
export const AuthorizationContractSchema = Type.Object(
  {
    permissions: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    scopeField: Type.Optional(Type.String({ minLength: 1 })),
    actorRequired: Type.Literal(true),
  },
  { additionalProperties: false },
);

/** Receipt, audit, fact, and outbox event share one transaction. */
export const TransactionContractSchema = Type.Object(
  {
    atomicWrites: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    sideEffects: Type.Array(Type.String()),
    rollbackOnError: Type.Literal(true),
  },
  { additionalProperties: false },
);

/** Outbox events are ordered and deduplicated by their durable identity. */
export const EventContractSchema = Type.Object(
  {
    events: Type.Array(Type.String({ minLength: 1 })),
    ordering: Type.Literal("outbox-sequence"),
    dedupe: Type.Literal("event-id"),
  },
  { additionalProperties: false },
);

/** Failure recovery is explicit; a replay must reach the same final state. */
export const RecoveryContractSchema = Type.Object(
  {
    retry: Type.Literal("same-command-id"),
    responseLoss: Type.Literal("replay-receipt"),
    deadLetter: Type.Optional(Type.String({ minLength: 1 })),
    finalState: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export type IdempotencyContract = Static<typeof IdempotencyContractSchema>;
export type AuthorizationContract = Static<typeof AuthorizationContractSchema>;
export type TransactionContract = Static<typeof TransactionContractSchema>;
export type EventContract = Static<typeof EventContractSchema>;
export type RecoveryContract = Static<typeof RecoveryContractSchema>;
