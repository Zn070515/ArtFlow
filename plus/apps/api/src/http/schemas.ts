import { Type } from "@sinclair/typebox";

import { ExecutionModeSchema } from "@artflow-plus/contracts";

export const CreateActivityBody = Type.Object(
  {
    title: Type.String({ minLength: 1, maxLength: 200 }),
    capabilities: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 80 }), { uniqueItems: true }),
    ),
    packId: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
    answers: Type.Optional(Type.Record(Type.String(), Type.Boolean())),
    enable: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 80 }), { uniqueItems: true }),
    ),
    disable: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 80 }), { uniqueItems: true }),
    ),
  },
  { additionalProperties: false },
);

export const ActivityParams = Type.Object(
  { id: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);

export const PublicVoteParams = Type.Object(
  { sessionId: Type.String({ minLength: 1, maxLength: 100 }) },
  { additionalProperties: false },
);

export const PublicActivityParams = Type.Object(
  { publicCode: Type.String({ minLength: 1, maxLength: 100 }) },
  { additionalProperties: false },
);

export const PackParams = Type.Object(
  { id: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);

export const SessionParams = Type.Object(
  { id: Type.String({ minLength: 1 }), sessionId: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);

export const TicketParams = Type.Object(
  { id: Type.String({ minLength: 1 }), ticketId: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);

export const TicketSessionParams = Type.Object(
  { id: Type.String({ minLength: 1 }), sessionId: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);

export const ActivateBody = Type.Object(
  { expectedRevision: Type.Integer({ minimum: 0 }) },
  { additionalProperties: false },
);

export const CompileBody = Type.Object(
  {
    package: Type.Unknown(),
    expectedDraftRevision: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

export const ReleaseBody = Type.Object(
  { expectedDraftRevision: Type.Integer({ minimum: 0 }) },
  { additionalProperties: false },
);

export const EventsQuery = Type.Object(
  {
    after: Type.Optional(Type.Integer({ minimum: 0 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
    mode: Type.Optional(ExecutionModeSchema),
  },
  { additionalProperties: false },
);

export const StateQuery = Type.Object(
  { mode: Type.Optional(ExecutionModeSchema) },
  { additionalProperties: false },
);

export const RuntimeFactBody = Type.Object(
  {
    capability: Type.String({ pattern: "^[a-z][a-z0-9_-]*$", maxLength: 80 }),
    scope: Type.String({ pattern: "^[a-z][a-z0-9_-]*$", maxLength: 100 }),
    type: Type.String({ pattern: "^[A-Z][A-Za-z0-9]+$", maxLength: 100 }),
    payload: Type.Unknown(),
  },
  { additionalProperties: false },
);

export const LoginBody = Type.Object(
  {
    username: Type.String({ minLength: 1, maxLength: 100 }),
    password: Type.String({ minLength: 1, maxLength: 200 }),
  },
  { additionalProperties: false },
);

export const RegistrationBody = Type.Object(
  { participantId: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })) },
  { additionalProperties: false },
);

export const RegistrationParams = Type.Object(
  { id: Type.String({ minLength: 1 }), registrationId: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);

export const GroupingStageParams = Type.Object(
  { id: Type.String({ minLength: 1 }), stageId: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);

export const CreateGroupingStageBody = Type.Object(
  {
    stageKey: Type.String({ minLength: 1, maxLength: 100 }),
    name: Type.String({ minLength: 1, maxLength: 200 }),
    rosterSource: Type.Union([Type.Literal("all_approved"), Type.Literal("round_advanced")]),
    sourceRoundId: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
  },
  { additionalProperties: false },
);

export const GroupingGroupSpecSchema = Type.Object(
  {
    name: Type.Optional(Type.String({ maxLength: 200 })),
    participantIds: Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { minItems: 1 }),
  },
  { additionalProperties: false },
);

export const RecordGroupingGroupsBody = Type.Object(
  {
    expectedRevision: Type.Integer({ minimum: 1 }),
    groups: Type.Array(GroupingGroupSpecSchema, { minItems: 1 }),
  },
  { additionalProperties: false },
);

export const GroupingRevisionBody = Type.Object(
  { expectedRevision: Type.Integer({ minimum: 1 }) },
  { additionalProperties: false },
);

export const CorrectGroupingBody = Type.Object(
  {
    expectedRevision: Type.Integer({ minimum: 1 }),
    groups: Type.Array(GroupingGroupSpecSchema, { minItems: 1 }),
    reason: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const CancelGroupingBody = Type.Object(
  {
    expectedRevision: Type.Integer({ minimum: 1 }),
    reason: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const GroupingWindowBody = Type.Object(
  {
    expectedRevision: Type.Integer({ minimum: 1 }),
    window: Type.Union([
      Type.Literal("closed"),
      Type.Literal("open"),
      Type.Literal("supplement_only"),
    ]),
    note: Type.Optional(Type.String({ maxLength: 500 })),
  },
  { additionalProperties: false },
);

export const VoteResultParamsSchema = Type.Object(
  { id: Type.String({ minLength: 1 }), sessionId: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);

export const ConfirmVoteResultBodySchema = Type.Object(
  {
    scope: Type.String({ minLength: 1, maxLength: 100 }),
    voteSessionId: Type.String({ minLength: 1, maxLength: 100 }),
    expectedSessionRevision: Type.Integer({ minimum: 1 }),
    expectedInputFingerprint: Type.String({ minLength: 1, maxLength: 128 }),
    awards: Type.Array(
      Type.Object(
        {
          award: Type.String({ minLength: 1, maxLength: 100 }),
          contestantId: Type.String({ minLength: 1, maxLength: 100 }),
        },
        { additionalProperties: false },
      ),
    ),
    note: Type.Optional(Type.String({ maxLength: 2000 })),
  },
  { additionalProperties: false },
);

export const AnswerBody = Type.Object(
  {
    expectedRevision: Type.Integer({ minimum: 0 }),
    questionKey: Type.String({ minLength: 1, maxLength: 100 }),
    value: Type.Unknown(),
  },
  { additionalProperties: false },
);

export const SubmitBody = Type.Object(
  { expectedRevision: Type.Integer({ minimum: 0 }) },
  { additionalProperties: false },
);

export const ReopenRosterBody = Type.Object(
  {
    expectedRevision: Type.Integer({ minimum: 0 }),
    reason: Type.String({ minLength: 1, maxLength: 500 }),
  },
  { additionalProperties: false },
);

export const ReviewRegistrationBody = Type.Object(
  {
    expectedRevision: Type.Integer({ minimum: 0 }),
    status: Type.Union([Type.Literal("approved"), Type.Literal("need_supplement"), Type.Literal("rejected")]),
    note: Type.String({ maxLength: 2000 }),
  },
  { additionalProperties: false },
);

export const MaterialBody = Type.Object(
  {
    registrationId: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
    questionKey: Type.String({ minLength: 1, maxLength: 100 }),
    originalName: Type.String({ minLength: 1, maxLength: 255 }),
    contentType: Type.String({ minLength: 1, maxLength: 150 }),
    byteLength: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const MaterialParams = Type.Object(
  { id: Type.String({ minLength: 1 }), materialId: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);

export const RegistrationMaterialParams = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    registrationId: Type.String({ minLength: 1 }),
    materialId: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const ReviewMaterialBody = Type.Object(
  {
    expectedRevision: Type.Integer({ minimum: 0 }),
    status: Type.Union([Type.Literal("approved"), Type.Literal("needs_supplement")]),
    note: Type.String({ maxLength: 2000 }),
  },
  { additionalProperties: false },
);

export const RoundParams = Type.Object(
  { id: Type.String({ minLength: 1 }), roundKey: Type.String({ minLength: 1, maxLength: 100 }) },
  { additionalProperties: false },
);

export const PrepareRoundBody = Type.Object(
  { scope: Type.String({ minLength: 1, maxLength: 100 }) },
  { additionalProperties: false },
);

export const ScheduleModeSchema = Type.Union([
  Type.Literal("test"),
  Type.Literal("rehearsal"),
  Type.Literal("formal"),
]);

export const ScheduleQuery = Type.Object(
  { mode: Type.Optional(ScheduleModeSchema) },
  { additionalProperties: false },
);

export const ScheduleEntryBody = Type.Object(
  {
    mode: ScheduleModeSchema,
    expectedRevision: Type.Integer({ minimum: 0 }),
    entryId: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
    slotKey: Type.String({ minLength: 1, maxLength: 64 }),
    participantId: Type.Optional(Type.Union([
      Type.String({ minLength: 1, maxLength: 100 }),
      Type.Null(),
    ])),
    title: Type.String({ minLength: 1, maxLength: 200 }),
    note: Type.Optional(Type.String({ maxLength: 500 })),
    position: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

export const ScheduleReorderBody = Type.Object(
  {
    mode: ScheduleModeSchema,
    expectedRevision: Type.Integer({ minimum: 0 }),
    orderedIds: Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { uniqueItems: true }),
  },
  { additionalProperties: false },
);

export const ScheduleRemoveBody = Type.Object(
  {
    mode: ScheduleModeSchema,
    expectedRevision: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const ScheduleReleaseBody = Type.Object(
  {
    mode: ScheduleModeSchema,
    expectedRevision: Type.Integer({ minimum: 0 }),
    note: Type.Optional(Type.String({ maxLength: 500 })),
  },
  { additionalProperties: false },
);

export const ScheduleRevokeBody = Type.Object(
  {
    expectedRevision: Type.Integer({ minimum: 0 }),
    note: Type.Optional(Type.String({ maxLength: 500 })),
  },
  { additionalProperties: false },
);

export const ScheduleEntryParams = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    entryId: Type.String({ minLength: 1, maxLength: 100 }),
  },
  { additionalProperties: false },
);

export const ScheduleReleaseParams = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    releaseId: Type.String({ minLength: 1, maxLength: 100 }),
  },
  { additionalProperties: false },
);

export const IncidentModeSchema = Type.Union([
  Type.Literal("test"),
  Type.Literal("rehearsal"),
  Type.Literal("formal"),
]);

export const IncidentSeveritySchema = Type.Union([
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("critical"),
]);

export const IncidentCategorySchema = Type.Union([
  Type.Literal("participant"),
  Type.Literal("judge"),
  Type.Literal("stage"),
  Type.Literal("technical"),
  Type.Literal("safety"),
  Type.Literal("other"),
]);

export const IncidentQuery = Type.Object(
  { mode: Type.Optional(IncidentModeSchema) },
  { additionalProperties: false },
);

export const IncidentBody = Type.Object(
  {
    mode: IncidentModeSchema,
    severity: IncidentSeveritySchema,
    category: IncidentCategorySchema,
    title: Type.String({ minLength: 1, maxLength: 200 }),
    detail: Type.Optional(Type.String({ maxLength: 2000 })),
    location: Type.Optional(Type.String({ maxLength: 200 })),
    relatedType: Type.Optional(Type.Union([
      Type.Literal("schedule_entry"),
      Type.Literal("performance"),
      Type.Literal("round"),
      Type.Literal("registration"),
    ])),
    relatedId: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
  },
  { additionalProperties: false },
);

export const IncidentParams = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    incidentId: Type.String({ minLength: 1, maxLength: 100 }),
  },
  { additionalProperties: false },
);

export const IncidentRevisionBody = Type.Object(
  { expectedRevision: Type.Integer({ minimum: 0 }) },
  { additionalProperties: false },
);

export const ResolveIncidentBody = Type.Object(
  {
    expectedRevision: Type.Integer({ minimum: 0 }),
    resolution: Type.String({ minLength: 1, maxLength: 2000 }),
  },
  { additionalProperties: false },
);

export const DuplicateActivityBody = Type.Object(
  { title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })) },
  { additionalProperties: false },
);

export const ReopenIncidentBody = Type.Object(
  {
    expectedRevision: Type.Integer({ minimum: 0 }),
    reason: Type.String({ minLength: 1, maxLength: 500 }),
  },
  { additionalProperties: false },
);
