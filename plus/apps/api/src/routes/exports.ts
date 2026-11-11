import { Type } from "@sinclair/typebox";

import { exportActivityCsv, type ExportKind } from "@artflow-plus/runtime";

import type { ApiContext } from "../http/context.js";

const ExportParams = Type.Object({
  id: Type.String({ minLength: 1 }),
  kind: Type.Union([
    Type.Literal("registrations"),
    Type.Literal("materials"),
    Type.Literal("scores"),
    Type.Literal("votes"),
  ]),
});

export function registerExportRoutes(ctx: ApiContext): void {
  const { app, db, requestDeps } = ctx;

  app.get(
    "/api/activities/:id/exports/:kind",
    { schema: { params: ExportParams }, config: { access: "session" } },
    async (request, reply) => {
      const { id, kind } = request.params as { id: string; kind: ExportKind };
      const result = await exportActivityCsv(db, await requestDeps(request), {
        activityId: id,
        kind,
      });
      reply.header("content-type", "text/csv; charset=utf-8");
      reply.header("content-disposition", `attachment; filename="${result.filename}"`);
      reply.header("cache-control", "no-store");
      return reply.send(result.csv);
    },
  );
}
