import { Type, type Static } from "@sinclair/typebox";

export const LifecycleTransitionSchema = Type.Object(
  {
    command: Type.String({ minLength: 1 }),
    from: Type.String({ minLength: 1 }),
    to: Type.String({ minLength: 1 }),
    revisionDelta: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

/**
 * A single aggregate's states and legal edges. It intentionally does not model
 * cross-aggregate effects; those belong to the command contract or the adapter.
 */
export const LifecycleContractSchema = Type.Object(
  {
    states: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    initial: Type.String({ minLength: 1 }),
    terminal: Type.Array(Type.String({ minLength: 1 })),
    transitions: Type.Array(LifecycleTransitionSchema),
  },
  { additionalProperties: false },
);

export type LifecycleTransition = Static<typeof LifecycleTransitionSchema>;
export type LifecycleContract = Static<typeof LifecycleContractSchema>;
