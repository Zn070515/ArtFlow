import { Type, type Static } from "@sinclair/typebox";

/** Shared transport primitives; kept separate to avoid schema import cycles. */
export const ExecutionModeSchema = Type.Union([
  Type.Literal("test"),
  Type.Literal("rehearsal"),
  Type.Literal("formal"),
]);

export type ExecutionModeContract = Static<typeof ExecutionModeSchema>;
