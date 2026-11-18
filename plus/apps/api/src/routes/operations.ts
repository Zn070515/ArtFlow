import { OperationsRiskResponseSchema } from "@artflow-plus/contracts";
import { getActivityFeedback, getOperationsRiskBoard } from "@artflow-plus/runtime";

import type { ApiContext } from "../http/context.js";
import { ActivityParams } from "../http/schemas.js";

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
