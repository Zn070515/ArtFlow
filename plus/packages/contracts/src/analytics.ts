import { Type, type Static } from "@sinclair/typebox";

const StatusCountsSchema = Type.Record(Type.String({ minLength: 1 }), Type.Integer({ minimum: 0 }));
const ActivityAnalyticsParamsSchema = Type.Object(
  { id: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);

const RegistrationAnalyticsSchema = Type.Object({
  total: Type.Integer({ minimum: 0 }),
  byStatus: StatusCountsSchema,
});

const MaterialAnalyticsSchema = Type.Object({
  total: Type.Integer({ minimum: 0 }),
  byStatus: StatusCountsSchema,
  requiredNotApproved: Type.Integer({ minimum: 0 }),
});

const RosterAnalyticsSchema = Type.Object({
  status: Type.Union([Type.Literal("unknown"), Type.Literal("final")]),
  approvedCount: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  revision: Type.Integer({ minimum: 0 }),
});

const CompetitionAnalyticsSchema = Type.Object({
  rounds: Type.Object({
    total: Type.Integer({ minimum: 0 }),
    byState: StatusCountsSchema,
    locked: Type.Integer({ minimum: 0 }),
  }),
  performances: Type.Object({
    total: Type.Integer({ minimum: 0 }),
    byState: StatusCountsSchema,
    locked: Type.Integer({ minimum: 0 }),
  }),
  scoreFacts: Type.Object({
    total: Type.Integer({ minimum: 0 }),
    current: Type.Integer({ minimum: 0 }),
  }),
});

const VotingAnalyticsSchema = Type.Object({
  sessions: Type.Object({ total: Type.Integer({ minimum: 0 }), byStatus: StatusCountsSchema }),
  validBallots: Type.Integer({ minimum: 0 }),
});

const PublishingAnalyticsSchema = Type.Object({
  stageResults: Type.Object({
    total: Type.Integer({ minimum: 0 }),
    byStatus: StatusCountsSchema,
    stale: Type.Integer({ minimum: 0 }),
    confirmedWithoutActiveRelease: Type.Integer({ minimum: 0 }),
  }),
  resultReleases: Type.Object({ total: Type.Integer({ minimum: 0 }), byStatus: StatusCountsSchema }),
});

const ArchiveAnalyticsSchema = Type.Object({
  totalPackages: Type.Integer({ minimum: 0 }),
  currentPackages: Type.Integer({ minimum: 0 }),
});

const AttentionSchema = Type.Object({
  code: Type.String({ minLength: 1, maxLength: 100 }),
  severity: Type.Literal("warning"),
  count: Type.Optional(Type.Integer({ minimum: 1 })),
});

export const ActivityAnalyticsResponseSchema = Type.Object({
  activity: Type.Object({
    id: Type.String({ minLength: 1 }),
    title: Type.String({ minLength: 1 }),
    status: Type.Union([
      Type.Literal("draft"),
      Type.Literal("active"),
      Type.Literal("closed"),
      Type.Literal("archived"),
    ]),
    enabledCapabilities: Type.Array(Type.String({ minLength: 1 })),
  }),
  registration: RegistrationAnalyticsSchema,
  materialChecks: MaterialAnalyticsSchema,
  roster: RosterAnalyticsSchema,
  competition: CompetitionAnalyticsSchema,
  voting: VotingAnalyticsSchema,
  publishing: PublishingAnalyticsSchema,
  archive: ArchiveAnalyticsSchema,
  attention: Type.Array(AttentionSchema),
});

export type ActivityAnalyticsParams = Static<typeof ActivityAnalyticsParamsSchema>;
export type ActivityAnalyticsResponse = Static<typeof ActivityAnalyticsResponseSchema>;

export { ActivityAnalyticsParamsSchema };
