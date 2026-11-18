import { OperationsRiskResponseSchema } from "@artflow-plus/contracts";
import { getOperationsRiskBoard } from "@artflow-plus/runtime";

import type { ApiContext } from "../http/context.js";

export function registerOperationsRoutes(ctx: ApiContext): void {
  const { app, db, requestDeps } = ctx;

  app.get(
    "/api/operations/risks",
    {
      schema: { response: { 200: OperationsRiskResponseSchema } },
      config: { access: "analytics" },
    },
    async (request) => getOperationsRiskBoard(db, await requestDeps(request)),
  );
}
