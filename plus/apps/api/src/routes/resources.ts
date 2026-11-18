import { Type } from "@sinclair/typebox";

import {
  cancelResourceBookingCommand,
  confirmResourceBookingCommand,
  createResourceBooking,
  getResourcesView,
  updateResourceBooking,
} from "@artflow-plus/runtime";

import type { ApiContext } from "../http/context.js";
import { requireIdempotency } from "../http/helpers.js";

const ActivityParams = Type.Object({ id: Type.String({ minLength: 1 }) }, { additionalProperties: false });
const BookingParams = Type.Object({
  id: Type.String({ minLength: 1 }),
  bookingId: Type.String({ minLength: 1 }),
}, { additionalProperties: false });

const CreateBody = Type.Object({
  resourceKey: Type.String({ minLength: 1, maxLength: 80 }),
  title: Type.String({ minLength: 1, maxLength: 200 }),
  note: Type.Optional(Type.String({ maxLength: 2000 })),
  startsAt: Type.String({ minLength: 1, maxLength: 40 }),
  endsAt: Type.String({ minLength: 1, maxLength: 40 }),
}, { additionalProperties: false });

const UpdateBody = Type.Object({
  title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  note: Type.Optional(Type.String({ maxLength: 2000 })),
  startsAt: Type.Optional(Type.String({ minLength: 1, maxLength: 40 })),
  endsAt: Type.Optional(Type.String({ minLength: 1, maxLength: 40 })),
  expectedRevision: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false });

const RevisionBody = Type.Object({
  expectedRevision: Type.Integer({ minimum: 0 }),
  reason: Type.Optional(Type.String({ maxLength: 1000 })),
}, { additionalProperties: false });

export function registerResourcesRoutes(ctx: ApiContext): void {
  const { app, db, requestDeps } = ctx;

  app.get("/api/activities/:id/resources", { schema: { params: ActivityParams }, config: { access: "session" } }, async (request) => {
    const { id } = request.params as { id: string };
    return await getResourcesView(db, await requestDeps(request), id);
  });

  app.post("/api/activities/:id/resources/bookings", { schema: { params: ActivityParams, body: CreateBody } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as {
      resourceKey: string;
      title: string;
      note?: string;
      startsAt: string;
      endsAt: string;
    };
    const outcome = await createResourceBooking(db, await requestDeps(request), {
      commandId: requireIdempotency(request),
      activityId: id,
      ...body,
    });
    return reply.status(outcome.status).send(outcome.body);
  });

  app.put("/api/activities/:id/resources/bookings/:bookingId", { schema: { params: BookingParams, body: UpdateBody } }, async (request) => {
    const { id, bookingId } = request.params as { id: string; bookingId: string };
    const body = request.body as {
      title?: string;
      note?: string;
      startsAt?: string;
      endsAt?: string;
      expectedRevision: number;
    };
    const outcome = await updateResourceBooking(db, await requestDeps(request), {
      commandId: requireIdempotency(request),
      activityId: id,
      bookingId,
      ...body,
    });
    return outcome.body;
  });

  app.post("/api/activities/:id/resources/bookings/:bookingId/confirm", { schema: { params: BookingParams, body: RevisionBody } }, async (request) => {
    const { id, bookingId } = request.params as { id: string; bookingId: string };
    const body = request.body as { expectedRevision: number };
    const outcome = await confirmResourceBookingCommand(db, await requestDeps(request), {
      commandId: requireIdempotency(request),
      activityId: id,
      bookingId,
      expectedRevision: body.expectedRevision,
    });
    return outcome.body;
  });

  app.post("/api/activities/:id/resources/bookings/:bookingId/cancel", { schema: { params: BookingParams, body: RevisionBody } }, async (request) => {
    const { id, bookingId } = request.params as { id: string; bookingId: string };
    const body = request.body as { expectedRevision: number; reason?: string };
    const outcome = await cancelResourceBookingCommand(db, await requestDeps(request), {
      commandId: requireIdempotency(request),
      activityId: id,
      bookingId,
      expectedRevision: body.expectedRevision,
      reason: body.reason ?? "",
    });
    return outcome.body;
  });
}
