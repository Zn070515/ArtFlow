import { Type, type Static } from "@sinclair/typebox";

const ScopeSchema = Type.String({ pattern: "^[a-z][a-z0-9_-]*$", maxLength: 100 });
const StageKeySchema = Type.String({ minLength: 1, maxLength: 100 });

export const PublishingStageParamsSchema = Type.Object(
  { id: Type.String({ minLength: 1 }), stageKey: StageKeySchema },
  { additionalProperties: false },
);

export const PublishingReleaseParamsSchema = Type.Object(
  { id: Type.String({ minLength: 1 }), releaseId: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);

export const PublicResultsParamsSchema = Type.Object(
  { publicCode: Type.String({ minLength: 1, maxLength: 100 }) },
  { additionalProperties: false },
);

export const PublicResultsQuerySchema = Type.Object(
  { stage: Type.Optional(StageKeySchema) },
  { additionalProperties: false },
);

const AwardSchema = Type.Object(
  {
    award: Type.String({ minLength: 1, maxLength: 100 }),
    contestantId: Type.String({ minLength: 1, maxLength: 100 }),
  },
  { additionalProperties: false },
);

export const ConfirmStageResultBodySchema = Type.Object(
  {
    scope: ScopeSchema,
    expectedSourceRevision: Type.Integer({ minimum: 1 }),
    expectedInputFingerprint: Type.String({ minLength: 1, maxLength: 128 }),
    awards: Type.Array(AwardSchema, { maxItems: 50 }),
    note: Type.Optional(Type.String({ maxLength: 2000 })),
  },
  { additionalProperties: false },
);

export const ReleaseResultBodySchema = Type.Object(
  {
    stageKey: StageKeySchema,
    scope: ScopeSchema,
    expectedCandidateRevision: Type.Integer({ minimum: 1 }),
    note: Type.String({ minLength: 1, maxLength: 2000 }),
  },
  { additionalProperties: false },
);

export const RevokeResultReleaseBodySchema = Type.Object(
  { scope: ScopeSchema, note: Type.String({ minLength: 1, maxLength: 2000 }) },
  { additionalProperties: false },
);

export const UnlockStageResultBodySchema = Type.Object(
  {
    scope: ScopeSchema,
    expectedCandidateRevision: Type.Integer({ minimum: 1 }),
    note: Type.String({ minLength: 1, maxLength: 2000 }),
  },
  { additionalProperties: false },
);

export const EditPublicationBodySchema = Type.Object(
  {
    scope: ScopeSchema,
    expectedVersion: Type.Integer({ minimum: 0 }),
    title: Type.String({ minLength: 1, maxLength: 300 }),
    content: Type.String({ maxLength: 20000 }),
  },
  { additionalProperties: false },
);

export type ConfirmStageResultBody = Static<typeof ConfirmStageResultBodySchema>;
export type ReleaseResultBody = Static<typeof ReleaseResultBodySchema>;
export type RevokeResultReleaseBody = Static<typeof RevokeResultReleaseBodySchema>;
export type UnlockStageResultBody = Static<typeof UnlockStageResultBodySchema>;
export type EditPublicationBody = Static<typeof EditPublicationBodySchema>;
export type PublicResultsQuery = Static<typeof PublicResultsQuerySchema>;
