import { Type, type Static } from "@sinclair/typebox";

const ScopeSchema = Type.String({ minLength: 1, maxLength: 100 });
const RoundKeySchema = Type.String({ minLength: 1, maxLength: 100 });
export const CompetitionRoundParamsSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  roundKey: RoundKeySchema,
}, { additionalProperties: false });

export const PrepareCompetitionRoundBodySchema = Type.Object({
  roundKey: RoundKeySchema,
  scope: ScopeSchema,
}, { additionalProperties: false });

export const ActivateCompetitionPanelBodySchema = Type.Object({
  scope: ScopeSchema,
  judges: Type.Array(Type.Object({
    judgeId: Type.String({ minLength: 1, maxLength: 100 }),
    seatKey: Type.String({ minLength: 1, maxLength: 100 }),
  }, { additionalProperties: false }), { minItems: 1 }),
}, { additionalProperties: false });

export const OpenCompetitionPerformanceBodySchema = Type.Object({
  scope: ScopeSchema,
  contestantId: Type.String({ minLength: 1, maxLength: 100 }),
  sequence: Type.Integer({ minimum: 1 }),
}, { additionalProperties: false });

export const CompetitionScopeBodySchema = Type.Object({
  scope: ScopeSchema,
}, { additionalProperties: false });

export const CompetitionRankingQuerySchema = Type.Object({
  scope: ScopeSchema,
  mode: Type.Optional(Type.Union([
    Type.Literal("test"),
    Type.Literal("rehearsal"),
    Type.Literal("formal"),
  ])),
}, { additionalProperties: false });

// One flat object: Fastify's AJV runs with removeAdditional, so an Intersect of
// two closed objects would strip each other's properties before validation.
export const CompetitionScoreBodySchema = Type.Object({
  performanceId: Type.String({ minLength: 1, maxLength: 100 }),
  panelSnapshotId: Type.String({ minLength: 1, maxLength: 100 }),
  seatId: Type.String({ minLength: 1, maxLength: 100 }),
  contextVersion: Type.Integer({ minimum: 0 }),
  scope: ScopeSchema,
  source: Type.Union([
    Type.Literal("direct_judge"),
    Type.Literal("staff_rapid"),
    Type.Literal("staff_proxy"),
    Type.Literal("paper_dr"),
  ]),
  criteria: Type.Record(Type.String({ minLength: 1, maxLength: 100 }), Type.Number()),
  notes: Type.Optional(Type.String({ maxLength: 2000 })),
  sourceReference: Type.Optional(Type.String({ maxLength: 200 })),
  reason: Type.Optional(Type.String({ maxLength: 2000 })),
}, { additionalProperties: false });

export const EditCompetitionScoreBodySchema = Type.Object({
  scope: ScopeSchema,
  performanceId: Type.String({ minLength: 1, maxLength: 100 }),
  panelSnapshotId: Type.String({ minLength: 1, maxLength: 100 }),
  seatId: Type.String({ minLength: 1, maxLength: 100 }),
  contextVersion: Type.Integer({ minimum: 0 }),
  expectedVersion: Type.Integer({ minimum: 1 }),
  criteria: Type.Record(Type.String({ minLength: 1, maxLength: 100 }), Type.Number()),
  reason: Type.String({ minLength: 1, maxLength: 2000 }),
  correctionId: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
}, { additionalProperties: false });

export const OpenScoreCorrectionBodySchema = Type.Object({
  scope: ScopeSchema,
  performanceId: Type.String({ minLength: 1, maxLength: 100 }),
  panelSnapshotId: Type.String({ minLength: 1, maxLength: 100 }),
  reason: Type.String({ minLength: 1, maxLength: 2000 }),
}, { additionalProperties: false });

export const ResolveCompetitionBodySchema = CompetitionScopeBodySchema;

export const LockCompetitionRoundBodySchema = Type.Object({
  scope: ScopeSchema,
  expectedRevision: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false });

export const FinalizeAdvancementBodySchema = Type.Object({
  scope: ScopeSchema,
  expectedRankingRevision: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false });

export const RecomputePodiumBodySchema = Type.Object({
  scope: ScopeSchema,
  roundIds: Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { minItems: 1 }),
  expectedInputFingerprint: Type.String({ minLength: 1, maxLength: 64 }),
}, { additionalProperties: false });

export const ScoreCorrectionLifecycleBodySchema = Type.Object({
  scope: ScopeSchema,
  panelSnapshotId: Type.String({ minLength: 1, maxLength: 100 }),
  performanceId: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
}, { additionalProperties: false });

export const TieDecisionBodySchema = Type.Object({
  scope: ScopeSchema,
  rankingSnapshotId: Type.String({ minLength: 1, maxLength: 100 }),
  inputFingerprint: Type.String({ minLength: 1, maxLength: 64 }),
  contestants: Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { minItems: 1 }),
  order: Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { minItems: 1 }),
  reason: Type.String({ minLength: 1, maxLength: 2000 }),
}, { additionalProperties: false });

export type CompetitionScoreBody = Static<typeof CompetitionScoreBodySchema>;
