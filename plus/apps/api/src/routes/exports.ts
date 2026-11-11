import type { ApiContext } from "../http/context.js";
import { buildStaffExport, type StaffExportKind } from "@artflow-plus/runtime";
import { Type } from "@sinclair/typebox";

const ExportParams = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    kind: Type.Union([
      Type.Literal("registrations"),
      Type.Literal("materials"),
      Type.Literal("scores"),
      Type.Literal("votes"),
    ]),
  },
  { additionalProperties: false },
);

export function registerExportRoutes(ctx: ApiContext): void {
  const { app, db } = ctx;

  app.get(
    "/api/activities/:id/exports/:kind",
    { schema: { params: ExportParams }, config: { access: "session" } },
    async (request, reply) => {
      const { id, kind } = request.params as { id: string; kind: StaffExportKind };
      const file = await buildStaffExport(db, await ctx.requestDeps(request), id, kind);
      return reply
        .type(file.contentType)
        .header("content-disposition", `attachment; filename="${file.filename}"`)
        .header("cache-control", "no-store")
        .header("x-content-type-options", "nosniff")
        .send(file.body);
    },
  );
}
