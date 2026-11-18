import { Type, type Static } from "@sinclair/typebox";

const RiskAttentionSchema = Type.Object({
  code: Type.String({ minLength: 1, maxLength: 100 }),
  count: Type.Optional(Type.Integer({ minimum: 1 })),
});

const RiskActivitySchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  title: Type.String({ minLength: 1 }),
  publicCode: Type.String({ minLength: 1 }),
  status: Type.Union([
    Type.Literal("draft"),
    Type.Literal("active"),
    Type.Literal("closed"),
    Type.Literal("archived"),
  ]),
  enabledCapabilities: Type.Array(Type.String({ minLength: 1 })),
});

export const OperationsRiskResponseSchema = Type.Object({
  activities: Type.Array(
    Type.Object({
      activity: RiskActivitySchema,
      attention: Type.Array(RiskAttentionSchema),
    }),
  ),
});

export type OperationsRiskResponse = Static<typeof OperationsRiskResponseSchema>;
