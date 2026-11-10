import { Type } from "@sinclair/typebox";
import {
  AttendanceCheckinBodySchema,
  AttendanceCurrentSchema,
  AttendanceListResponseSchema,
  AttendancePointBodySchema,
  AttendancePointSchema,
  AttendancePointUpdateBodySchema,
  AttendanceQuerySchema,
  AttendanceStaffBodySchema,
  AttendanceStaffListResponseSchema,
  AttendanceStaffSchema,
  AttendanceStaffUpdateBodySchema,
  AttendanceUndoBodySchema,
} from "@artflow-plus/contracts";
import { DomainError, type ActorContext } from "@artflow-plus/domain";
import {
  addAttendanceStaff,
  checkIn,
  createAttendancePoint,
  listAttendance,
  listAttendanceRoster,
  resolveTicketCredentialForAttendance,
  undoCheckIn,
  updateAttendancePointCommand,
  updateAttendanceStaffCommand,
} from "@artflow-plus/runtime";
import type { RuntimeDeps } from "@artflow-plus/runtime";

import type { ApiContext } from "../http/context.js";
import { ActivityParams } from "../http/schemas.js";
import { compileClosedTypeBoxSchema, requireIdempotency } from "../http/helpers.js";

const PointKeySchema = Type.String({ pattern: "^[a-z0-9][a-z0-9._-]{0,63}$" });

function requireActor(context: RuntimeDeps): ActorContext {
  if (context.actor === undefined) {
    throw new DomainError("UNAUTHENTICATED", "A session is required.");
  }
  return context.actor;
}

export function registerAttendanceRoutes(ctx: ApiContext): void {
  const { app, db, requestDeps } = ctx;

  app.get(
    "/api/activities/:id/attendance",
    {
      schema: {
        params: ActivityParams,
        querystring: AttendanceQuerySchema,
        response: { 200: AttendanceListResponseSchema },
      },
      config: { access: "attendance" },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const query = request.query as {
        point?: string;
        subjectType?: "participant" | "ticket" | "staff";
        query?: string;
        mode?: "formal" | "test";
        limit?: number;
        offset?: number;
      };
      const context = await requestDeps(request);
      return listAttendance(db, context, { activityId: id, ...query });
    },
  );

  app.get(
    "/api/activities/:id/attendance/staff",
    {
      schema: { params: ActivityParams, response: { 200: AttendanceStaffListResponseSchema } },
      config: { access: "attendance" },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      return listAttendanceRoster(db, await requestDeps(request), id);
    },
  );

  app.post(
    "/api/activities/:id/attendance/points",
    {
      schema: {
        params: ActivityParams,
        body: AttendancePointBodySchema,
        response: { 200: AttendancePointSchema, 201: AttendancePointSchema },
      },
      validatorCompiler: compileClosedTypeBoxSchema,
    },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id } = request.params as { id: string };
      const body = request.body as {
        key: string;
        name: string;
        subjectTypes: readonly ("participant" | "ticket" | "staff")[];
      };
      const context = await requestDeps(request);
      const outcome = await createAttendancePoint(db, context, {
        commandId, activityId: id, actor: requireActor(context), ...body,
      });
      return reply.code(201).send(outcome.body);
    },
  );

  app.post(
    "/api/activities/:id/attendance/points/:pointKey",
    {
      schema: {
        params: Type.Object(
          {
            id: Type.String({ minLength: 1, maxLength: 100 }),
            pointKey: PointKeySchema,
          },
          { additionalProperties: false },
        ),
        body: AttendancePointUpdateBodySchema,
        response: { 200: AttendancePointSchema },
      },
      validatorCompiler: compileClosedTypeBoxSchema,
    },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id, pointKey } = request.params as { id: string; pointKey: string };
      const body = request.body as {
        expectedRevision: number;
        name: string;
        subjectTypes: readonly ("participant" | "ticket" | "staff")[];
        active: boolean;
      };
      const context = await requestDeps(request);
      const outcome = await updateAttendancePointCommand(db, context, {
        commandId, activityId: id, actor: requireActor(context), pointKey, ...body,
      });
      return reply.code(200).send(outcome.body);
    },
  );

  app.post(
    "/api/activities/:id/attendance/staff",
    {
      schema: {
        params: ActivityParams,
        body: AttendanceStaffBodySchema,
        response: { 200: AttendanceStaffSchema, 201: AttendanceStaffSchema },
      },
      validatorCompiler: compileClosedTypeBoxSchema,
    },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id } = request.params as { id: string };
      const body = request.body as { displayName: string; actorId?: string | null };
      const context = await requestDeps(request);
      const outcome = await addAttendanceStaff(db, context, {
        commandId, activityId: id, actor: requireActor(context), ...body,
      });
      return reply.code(201).send(outcome.body);
    },
  );

  app.post(
    "/api/activities/:id/attendance/staff/:staffId",
    {
      schema: {
        params: Type.Object(
          {
            id: Type.String({ minLength: 1, maxLength: 100 }),
            staffId: Type.String({ minLength: 1, maxLength: 100 }),
          },
          { additionalProperties: false },
        ),
        body: AttendanceStaffUpdateBodySchema,
        response: { 200: AttendanceStaffSchema },
      },
      validatorCompiler: compileClosedTypeBoxSchema,
    },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id, staffId } = request.params as { id: string; staffId: string };
      const body = request.body as {
        expectedRevision: number;
        displayName: string;
        actorId: string | null;
        active: boolean;
      };
      const context = await requestDeps(request);
      const outcome = await updateAttendanceStaffCommand(db, context, {
        commandId, activityId: id, actor: requireActor(context), staffId, ...body,
      });
      return reply.code(200).send(outcome.body);
    },
  );

  app.post(
    "/api/activities/:id/attendance/checkin",
    {
      schema: {
        params: ActivityParams,
        body: AttendanceCheckinBodySchema,
        response: { 200: AttendanceCurrentSchema },
      },
      validatorCompiler: compileClosedTypeBoxSchema,
    },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id } = request.params as { id: string };
      const body = request.body as {
        pointKey: string;
        subjectType: "participant" | "ticket" | "staff";
        subjectId?: string;
        ticketId?: string;
        credential?: string;
        note?: string;
      };
      const context = await requestDeps(request);
      const actor = requireActor(context);
      let subjectId: string | undefined = body.subjectId;
      if (body.subjectType === "ticket") {
        if (body.ticketId !== undefined) {
          subjectId = body.ticketId;
        } else if (body.credential !== undefined) {
          const resolved = await resolveTicketCredentialForAttendance(db, context, body.credential);
          if (resolved.activityId !== id) {
            throw new DomainError("CROSS_ACTIVITY", "The ticket belongs to another activity.");
          }
          subjectId = resolved.ticketId;
        }
      }
      if (subjectId === undefined || subjectId.trim() === "") {
        throw new DomainError("INVALID_INPUT", "A subject id or ticket credential is required.");
      }
      const outcome = await checkIn(db, context, {
        commandId,
        activityId: id,
        actor,
        pointKey: body.pointKey,
        subjectType: body.subjectType,
        subjectId,
        ...(body.note === undefined ? {} : { note: body.note }),
      });
      return reply.code(200).send(outcome.body);
    },
  );

  app.post(
    "/api/activities/:id/attendance/undo",
    {
      schema: {
        params: ActivityParams,
        body: AttendanceUndoBodySchema,
        response: { 200: AttendanceCurrentSchema },
      },
      validatorCompiler: compileClosedTypeBoxSchema,
    },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id } = request.params as { id: string };
      const body = request.body as {
        pointKey: string;
        subjectType: "participant" | "ticket" | "staff";
        subjectId: string;
        note?: string;
      };
      const context = await requestDeps(request);
      const outcome = await undoCheckIn(db, context, {
        commandId, activityId: id, actor: requireActor(context), ...body,
      });
      return reply.code(200).send(outcome.body);
    },
  );
}
