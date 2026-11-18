import { OperationsRiskResponseSchema } from "@artflow-plus/contracts";
import {
  getActivityFeedback,
  getOperationsRiskBoard,
  rebuildProjection,
  retryProjection,
} from "@artflow-plus/runtime";
import { Type } from "@sinclair/typebox";

import type { ApiContext } from "../http/context.js";
import { ActivityParams } from "../http/schemas.js";

const ProjectionModeParams = Type.Object({
  id: Type.String({ minLength: 1 }),
  mode: Type.Union([Type.Literal("test"), Type.Literal("rehearsal"), Type.Literal("formal")]),
});

export function registerOperationsRoutes(ctx: ApiContext): void {
  const { app, db, requestDeps, requireOperationsReader } = ctx;

  app.get(
    "/api/operations/risks",
    {
      schema: { response: { 200: OperationsRiskResponseSchema } },
      config: { access: "analytics" },
    },
    async (request) => getOperationsRiskBoard(db, await requestDeps(request)),
  );

  app.post(
    "/api/activities/:id/projections/:mode/retry",
    { schema: { params: ProjectionModeParams } },
    async (request) => {
      const { id, mode } = request.params as { id: string; mode: string };
      return await retryProjection(db, await requestDeps(request), { activityId: id, mode });
    },
  );

  app.post(
    "/api/activities/:id/projections/:mode/rebuild",
    { schema: { params: ProjectionModeParams } },
    async (request) => {
      const { id, mode } = request.params as { id: string; mode: string };
      return await rebuildProjection(db, await requestDeps(request), { activityId: id, mode });
    },
  );

  app.get(
    "/api/activities/:id/feedback",
    { schema: { params: ActivityParams }, config: { access: "session" } },
    async (request) => {
      const { id } = request.params as { id: string };
      await requireOperationsReader(request);
      return getActivityFeedback(db, id);
    },
  );
}
