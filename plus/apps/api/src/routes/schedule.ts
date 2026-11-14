import type { ApiContext } from "../http/context.js";
import { requireIdempotency } from "../http/helpers.js";
import { ActivityParams } from "../http/schemas.js";
import {
  ScheduleEntryBody,
  ScheduleEntryParams,
  ScheduleQuery,
  ScheduleReleaseBody,
  ScheduleReleaseParams,
  ScheduleRemoveBody,
  ScheduleReorderBody,
  ScheduleRevokeBody,
} from "../http/schemas.js";
import {
  advanceSchedule,
  getScheduleState,
  releaseSchedule,
  removeScheduleEntry,
  reorderSchedule,
  revokeScheduleReleaseCommand,
  upsertScheduleEntry,
} from "@artflow-plus/runtime";

export function registerScheduleRoutes(ctx: ApiContext): void {
  const { app, db, requestDeps } = ctx;

  app.get(
    "/api/activities/:id/schedule",
    { schema: { params: ActivityParams, querystring: ScheduleQuery }, config: { access: "schedule" } },
    async (request) => {
      const { id } = request.params as { id: string };
      const { mode } = request.query as { mode?: string };
      return getScheduleState(db, id, mode ?? "formal");
    },
  );

  app.post(
    "/api/activities/:id/schedule/entries",
    { schema: { params: ActivityParams, body: ScheduleEntryBody } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id } = request.params as { id: string };
      const body = request.body as {
        mode: string;
        expectedRevision: number;
        entryId?: string;
        slotKey: string;
        participantId?: string | null;
        title: string;
        note?: string;
        position?: number;
      };
      const outcome = await upsertScheduleEntry(db, await requestDeps(request), {
        commandId,
        activityId: id,
        ...body,
      });
      return reply.status(outcome.status).send(outcome.body);
    },
  );

  app.post(
    "/api/activities/:id/schedule/reorder",
    { schema: { params: ActivityParams, body: ScheduleReorderBody } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id } = request.params as { id: string };
      const body = request.body as {
        mode: string;
        expectedRevision: number;
        orderedIds: string[];
      };
      const outcome = await reorderSchedule(db, await requestDeps(request), {
        commandId,
        activityId: id,
        ...body,
      });
      return reply.status(outcome.status).send(outcome.body);
    },
  );

  app.post(
    "/api/activities/:id/schedule/entries/:entryId/remove",
    { schema: { params: ScheduleEntryParams, body: ScheduleRemoveBody } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id, entryId } = request.params as { id: string; entryId: string };
      const body = request.body as { mode: string; expectedRevision: number };
      const outcome = await removeScheduleEntry(db, await requestDeps(request), {
        commandId,
        activityId: id,
        entryId,
        ...body,
      });
      return reply.status(outcome.status).send(outcome.body);
    },
  );

  app.post(
    "/api/activities/:id/schedule/release",
    { schema: { params: ActivityParams, body: ScheduleReleaseBody } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id } = request.params as { id: string };
      const body = request.body as { mode: string; expectedRevision: number; note?: string };
      const outcome = await releaseSchedule(db, await requestDeps(request), {
        commandId,
        activityId: id,
        ...body,
      });
      return reply.status(outcome.status).send(outcome.body);
    },
  );

  app.post(
    "/api/activities/:id/schedule/releases/:releaseId/revoke",
    { schema: { params: ScheduleReleaseParams, body: ScheduleRevokeBody } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id, releaseId } = request.params as { id: string; releaseId: string };
      const body = request.body as { note?: string };
      const outcome = await revokeScheduleReleaseCommand(db, await requestDeps(request), {
        commandId,
        activityId: id,
        releaseId,
        note: body.note,
      });
      return reply.status(outcome.status).send(outcome.body);
    },
  );

  app.post(
    "/api/activities/:id/schedule/advance",
    { schema: { params: ActivityParams } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id } = request.params as { id: string };
      const outcome = await advanceSchedule(db, await requestDeps(request), {
        commandId,
        activityId: id,
      });
      return reply.status(outcome.status).send(outcome.body);
    },
  );
}
