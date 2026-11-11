import { Type, type Static } from "@sinclair/typebox";

/** The small, orthogonal contract kinds the program composes per capability. */
export const ContractKindSchema = Type.Union([
  Type.Literal("lifecycle"),
  Type.Literal("transaction"),
  Type.Literal("authorization"),
  Type.Literal("idempotency"),
  Type.Literal("event"),
  Type.Literal("recovery"),
]);

/**
 * Metadata every contract carries. It deliberately describes the boundary,
 * not the implementation: the executable rules live in the harness templates
 * and the capability adapter.
 */
export const ContractDescriptorSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    version: Type.Integer({ minimum: 1 }),
    kind: ContractKindSchema,
    provider: Type.String({ minLength: 1 }),
    consumers: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    preconditions: Type.Array(Type.String()),
    outputs: Type.Array(Type.String()),
    invariants: Type.Array(Type.String()),
    errors: Type.Array(Type.String()),
    sideEffects: Type.Array(Type.String()),
    idempotency: Type.String(),
    concurrency: Type.String(),
    recovery: Type.String(),
  },
  { additionalProperties: false },
);

export type ContractKind = Static<typeof ContractKindSchema>;
export type ContractDescriptor = Static<typeof ContractDescriptorSchema>;
