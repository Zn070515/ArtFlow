import { Type, type Static } from "@sinclair/typebox";

const DateTimeSchema = Type.String({ format: "date-time", maxLength: 40 });
const PointKeySchema = Type.String({ pattern: "^[a-z0-9][a-z0-9._-]{0,63}$" });
const SubjectIdSchema = Type.String({ minLength: 1, maxLength: 100 });
const NoteSchema = Type.String({ maxLength: 500 });

export const AttendanceSubjectTypeSchema = Type.Union([
  Type.Literal("participant"),
  Type.Literal("ticket"),
  Type.Literal("staff"),
]);

export const AttendanceModeSchema = Type.Union([
  Type.Literal("formal"),
  Type.Literal("test"),
]);

export const AttendanceStatusSchema = Type.Union([
  Type.Literal("present"),
  Type.Literal("undone"),
  Type.Literal("not_checked_in"),
]);

export const AttendancePointSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 100 }),
    key: PointKeySchema,
    name: Type.String({ minLength: 1, maxLength: 120 }),
    subjectTypes: Type.Array(AttendanceSubjectTypeSchema, { minItems: 1, uniqueItems: true }),
    active: Type.Boolean(),
    revision: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const AttendanceStaffSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 100 }),
    displayName: Type.String({ minLength: 1, maxLength: 120 }),
    actorId: Type.Union([Type.String({ minLength: 1, maxLength: 100 }), Type.Null()]),
    active: Type.Boolean(),
    revision: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const AttendanceRowSchema = Type.Object(
  {
    pointKey: PointKeySchema,
    subjectType: AttendanceSubjectTypeSchema,
    subjectId: SubjectIdSchema,
    label: Type.String({ minLength: 1, maxLength: 200 }),
    eligible: Type.Boolean(),
    status: AttendanceStatusSchema,
    note: Type.Union([Type.String({ maxLength: 500 }), Type.Null()]),
    updatedAt: Type.Union([DateTimeSchema, Type.Null()]),
  },
  { additionalProperties: false },
);

export const AttendanceSummarySchema = Type.Object(
  {
    subjectType: AttendanceSubjectTypeSchema,
    expected: Type.Integer({ minimum: 0 }),
    present: Type.Integer({ minimum: 0 }),
    undone: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const AttendanceCurrentSchema = Type.Object(
  {
    activityId: Type.String({ minLength: 1, maxLength: 100 }),
    mode: AttendanceModeSchema,
    pointKey: PointKeySchema,
    subjectType: AttendanceSubjectTypeSchema,
    subjectId: SubjectIdSchema,
    status: Type.Union([Type.Literal("present"), Type.Literal("undone")]),
    note: Type.Union([Type.String({ maxLength: 500 }), Type.Null()]),
    revision: Type.Integer({ minimum: 0 }),
    updatedAt: DateTimeSchema,
  },
  { additionalProperties: false },
);

export const AttendanceListResponseSchema = Type.Object(
  {
    activityId: Type.String({ minLength: 1, maxLength: 100 }),
    mode: AttendanceModeSchema,
    points: Type.Array(AttendancePointSchema),
    staff: Type.Array(AttendanceStaffSchema),
    rows: Type.Array(AttendanceRowSchema),
    summary: Type.Array(AttendanceSummarySchema),
  },
  { additionalProperties: false },
);

export const AttendanceStaffListResponseSchema = Type.Object(
  {
    activityId: Type.String({ minLength: 1, maxLength: 100 }),
    staff: Type.Array(AttendanceStaffSchema),
  },
  { additionalProperties: false },
);

export const AttendanceQuerySchema = Type.Object(
  {
    point: Type.Optional(PointKeySchema),
    subjectType: Type.Optional(AttendanceSubjectTypeSchema),
    query: Type.Optional(Type.String({ maxLength: 100 })),
    mode: Type.Optional(AttendanceModeSchema),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
    offset: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

export const AttendancePointBodySchema = Type.Object(
  {
    key: PointKeySchema,
    name: Type.String({ minLength: 1, maxLength: 120 }),
    subjectTypes: Type.Array(AttendanceSubjectTypeSchema, { minItems: 1, uniqueItems: true }),
  },
  { additionalProperties: false },
);

export const AttendancePointUpdateBodySchema = Type.Object(
  {
    expectedRevision: Type.Integer({ minimum: 0 }),
    name: Type.String({ minLength: 1, maxLength: 120 }),
    subjectTypes: Type.Array(AttendanceSubjectTypeSchema, { minItems: 1, uniqueItems: true }),
    active: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const AttendanceStaffBodySchema = Type.Object(
  {
    displayName: Type.String({ minLength: 1, maxLength: 120 }),
    actorId: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 100 }), Type.Null()])),
  },
  { additionalProperties: false },
);

export const AttendanceStaffUpdateBodySchema = Type.Object(
  {
    expectedRevision: Type.Integer({ minimum: 0 }),
    displayName: Type.String({ minLength: 1, maxLength: 120 }),
    actorId: Type.Union([Type.String({ minLength: 1, maxLength: 100 }), Type.Null()]),
    active: Type.Boolean(),
  },
  { additionalProperties: false },
);

const CheckinBase = {
  pointKey: PointKeySchema,
  note: Type.Optional(NoteSchema),
};

export const AttendanceCheckinBodySchema = Type.Union([
  Type.Object(
    { ...CheckinBase, subjectType: Type.Literal("participant"), subjectId: SubjectIdSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    { ...CheckinBase, subjectType: Type.Literal("staff"), subjectId: SubjectIdSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    { ...CheckinBase, subjectType: Type.Literal("ticket"), ticketId: SubjectIdSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    { ...CheckinBase, subjectType: Type.Literal("ticket"), credential: Type.String({ minLength: 1, maxLength: 500 }) },
    { additionalProperties: false },
  ),
]);

export const AttendanceUndoBodySchema = Type.Object(
  {
    pointKey: PointKeySchema,
    subjectType: AttendanceSubjectTypeSchema,
    subjectId: SubjectIdSchema,
    note: Type.Optional(NoteSchema),
  },
  { additionalProperties: false },
);

export type AttendanceListResponse = Static<typeof AttendanceListResponseSchema>;
export type AttendanceStaffListResponse = Static<typeof AttendanceStaffListResponseSchema>;
export type AttendanceRow = Static<typeof AttendanceRowSchema>;
export type AttendancePoint = Static<typeof AttendancePointSchema>;
export type AttendanceStaff = Static<typeof AttendanceStaffSchema>;
export type AttendanceSummary = Static<typeof AttendanceSummarySchema>;
export type AttendanceCheckinBody = Static<typeof AttendanceCheckinBodySchema>;
export type AttendanceUndoBody = Static<typeof AttendanceUndoBodySchema>;
export type AttendanceCurrent = Static<typeof AttendanceCurrentSchema>;
