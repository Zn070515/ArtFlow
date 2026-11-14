import type { ApiContext } from "../http/context.js";
import { requireIdempotency } from "../http/helpers.js";
import {
  ActivityParams,
  IncidentBody,
  IncidentParams,
  IncidentQuery,
  IncidentRevisionBody,
  ReopenIncidentBody,
  ResolveIncidentBody,
} from "../http/schemas.js";
import {
  acknowledgeIncident,
  getIncidents,
  openIncident,
  reopenIncident,
  resolveIncident,
} from "@artflow-plus/runtime";

export function registerIncidentRoutes(ctx: ApiContext): void {
  const { app, db, requestDeps } = ctx;

  app.get(
    "/api/activities/:id/incidents",
    { schema: { params: ActivityParams, querystring: IncidentQuery }, config: { access: "incident" } },
    async (request) => {
      const { id } = request.params as { id: string };
      const { mode } = request.query as { mode?: "test" | "rehearsal" | "formal" };
      return { incidents: await getIncidents(db, id, mode) };
    },
  );

  app.post(
    "/api/activities/:id/incidents",
    { schema: { params: ActivityParams, body: IncidentBody } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id } = request.params as { id: string };
      const body = request.body as {
        mode: string;
        severity: string;
        category: string;
        title: string;
        detail?: string;
        location?: string;
        relatedType?: string;
        relatedId?: string;
      };
      const outcome = await openIncident(db, await requestDeps(request), {
        commandId,
        activityId: id,
        ...body,
      });
      return reply.status(outcome.status).send(outcome.body);
    },
  );

  app.post(
    "/api/activities/:id/incidents/:incidentId/acknowledge",
    { schema: { params: IncidentParams, body: IncidentRevisionBody } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id, incidentId } = request.params as { id: string; incidentId: string };
      const body = request.body as { expectedRevision: number };
      const outcome = await acknowledgeIncident(db, await requestDeps(request), {
        commandId,
        activityId: id,
        incidentId,
        ...body,
      });
      return reply.status(outcome.status).send(outcome.body);
    },
  );

  app.post(
    "/api/activities/:id/incidents/:incidentId/resolve",
    { schema: { params: IncidentParams, body: ResolveIncidentBody } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id, incidentId } = request.params as { id: string; incidentId: string };
      const body = request.body as { expectedRevision: number; resolution: string };
      const outcome = await resolveIncident(db, await requestDeps(request), {
        commandId,
        activityId: id,
        incidentId,
        ...body,
      });
      return reply.status(outcome.status).send(outcome.body);
    },
  );

  app.post(
    "/api/activities/:id/incidents/:incidentId/reopen",
    { schema: { params: IncidentParams, body: ReopenIncidentBody } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id, incidentId } = request.params as { id: string; incidentId: string };
      const body = request.body as { expectedRevision: number; reason: string };
      const outcome = await reopenIncident(db, await requestDeps(request), {
        commandId,
        activityId: id,
        incidentId,
        ...body,
      });
      return reply.status(outcome.status).send(outcome.body);
    },
  );
}
