import { Type, type Static } from "@sinclair/typebox";

const DateTimeSchema = Type.String({ format: "date-time", maxLength: 40 });
const TaskStatusSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("in_progress"),
  Type.Literal("blocked"),
  Type.Literal("done"),
]);

export const ActivityParamsSchema = Type.Object(
  { id: Type.String({ minLength: 1, maxLength: 100 }) },
  { additionalProperties: false },
);

export const TaskParamsSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 100 }),
    taskId: Type.String({ minLength: 1, maxLength: 100 }),
  },
  { additionalProperties: false },
);

export const SyncTaskBodySchema = Type.Object(
  { definitionVersion: Type.Integer({ minimum: 1 }) },
  { additionalProperties: false },
);

export const RevisionBodySchema = Type.Object(
  { expectedRevision: Type.Integer({ minimum: 0 }) },
  { additionalProperties: false },
);

export const AssignTaskBodySchema = Type.Object(
  {
    expectedRevision: Type.Integer({ minimum: 0 }),
    assigneeActorId: Type.Union([Type.String({ minLength: 1, maxLength: 100 }), Type.Null()]),
    dueAt: Type.Optional(Type.Union([DateTimeSchema, Type.Null()])),
  },
  { additionalProperties: false },
);

export const TaskReasonBodySchema = Type.Object(
  {
    expectedRevision: Type.Integer({ minimum: 0 }),
    reason: Type.String({ minLength: 1, maxLength: 2000 }),
  },
  { additionalProperties: false },
);

export const TaskResponseSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 100 }),
    activityId: Type.String({ minLength: 1, maxLength: 100 }),
    definitionVersion: Type.Integer({ minimum: 1 }),
    templateKey: Type.String({ minLength: 1, maxLength: 100 }),
    title: Type.String({ minLength: 1, maxLength: 200 }),
    sourceCapability: Type.String({ minLength: 1, maxLength: 100 }),
    sourceKey: Type.String({ minLength: 1, maxLength: 200 }),
    required: Type.Boolean(),
    status: TaskStatusSchema,
    assigneeActorId: Type.Union([Type.String({ minLength: 1, maxLength: 100 }), Type.Null()]),
    dueAt: Type.Union([DateTimeSchema, Type.Null()]),
    blockedReason: Type.Union([Type.String({ maxLength: 2000 }), Type.Null()]),
    completionReason: Type.Union([Type.String({ maxLength: 2000 }), Type.Null()]),
    revision: Type.Integer({ minimum: 0 }),
    createdAt: DateTimeSchema,
    updatedAt: DateTimeSchema,
  },
  { additionalProperties: false },
);

export const ReadinessSummarySchema = Type.Object(
  {
    total: Type.Integer({ minimum: 0 }),
    required: Type.Integer({ minimum: 0 }),
    done: Type.Integer({ minimum: 0 }),
    open: Type.Integer({ minimum: 0 }),
    blocked: Type.Integer({ minimum: 0 }),
    overdue: Type.Integer({ minimum: 0 }),
    byStatus: Type.Record(Type.String({ minLength: 1 }), Type.Integer({ minimum: 0 })),
    bySourceCapability: Type.Record(Type.String({ minLength: 1 }), Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

export const TaskListResponseSchema = Type.Object(
  {
    activityId: Type.String({ minLength: 1, maxLength: 100 }),
    definitionVersion: Type.Integer({ minimum: 1 }),
    tasks: Type.Array(TaskResponseSchema),
  },
  { additionalProperties: false },
);

export const TaskSyncResponseSchema = Type.Object(
  {
    definitionVersion: Type.Integer({ minimum: 1 }),
    createdCount: Type.Integer({ minimum: 0 }),
    tasks: Type.Array(TaskResponseSchema),
  },
  { additionalProperties: false },
);

export const ReadinessResponseSchema = Type.Object(
  {
    activityId: Type.String({ minLength: 1, maxLength: 100 }),
    definitionVersion: Type.Integer({ minimum: 1 }),
    summary: ReadinessSummarySchema,
    openTaskKeys: Type.Array(Type.String({ minLength: 1, maxLength: 100 })),
  },
  { additionalProperties: false },
);

export type TaskAction = "assign" | "start" | "block" | "complete" | "reopen";
export type TaskCommandBody = {
  readonly expectedRevision: number;
  readonly assigneeActorId?: string | null;
  readonly dueAt?: string | null;
  readonly reason?: string;
};
export type TaskResponse = Static<typeof TaskResponseSchema>;
export type TaskListResponse = Static<typeof TaskListResponseSchema>;
export type TaskSyncResponse = Static<typeof TaskSyncResponseSchema>;
export type ReadinessResponse = Static<typeof ReadinessResponseSchema>;
