import { Type } from "@sinclair/typebox";

import { DomainError } from "@artflow-plus/domain";
import {
  exportActivityTable,
  recordExportAudit,
  serializeCsv,
  type ExportFormat,
  type ExportKind,
} from "@artflow-plus/runtime";

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

const ExportQuery = Type.Object(
  {
    format: Type.Optional(
      Type.Union([Type.Literal("csv"), Type.Literal("docx"), Type.Literal("xlsx")]),
    ),
  },
  { additionalProperties: true },
);

export function registerExportRoutes(ctx: ApiContext): void {
  const { app, db, requestDeps, documentExporter } = ctx;

  // The Ops card needs a runtime signal: a build with no renderer must not
  // offer links that would download a 503 JSON body.
  app.get(
    "/api/exports/formats",
    { config: { access: "session" } },
    async () => ({
      formats: documentExporter === null
        ? (["csv"] as const)
        : (["csv", "docx", "xlsx"] as const),
    }),
  );

  app.get(
    "/api/activities/:id/exports/:kind",
    { schema: { params: ExportParams, querystring: ExportQuery }, config: { access: "session" } },
    async (request, reply) => {
      const { id, kind } = request.params as { id: string; kind: ExportKind };
      const query = request.query as { format?: ExportFormat };
      const format: ExportFormat = query.format ?? "csv";
      const deps = await requestDeps(request);

      // Read and authorize first; the audit entry is written only after the
      // document exists, so a failed render cannot look like a completed export.
      const table = await exportActivityTable(db, deps, { activityId: id, kind });
      reply.header("cache-control", "no-store");

      if (format === "csv") {
        const csv = serializeCsv(table);
        await recordExportAudit(db, deps, table, "csv");
        reply.header("content-type", "text/csv; charset=utf-8");
        reply.header(
          "content-disposition",
          `attachment; filename="${table.filenameStem}.csv"`,
        );
        return reply.send(csv);
      }

      if (documentExporter === null) {
        throw new DomainError(
          "EXPORT_UNAVAILABLE",
          "The document export service is not configured.",
        );
      }
      const rendered = await documentExporter.render({
        format,
        title: table.title,
        filenameStem: table.filenameStem,
        headers: table.headers,
        rows: table.rows,
      });
      await recordExportAudit(db, deps, table, format);
      reply.header("content-type", rendered.contentType);
      reply.header(
        "content-disposition",
        `attachment; filename="${table.filenameStem}.${rendered.extension}"`,
      );
      reply.header("content-length", String(rendered.bytes.length));
      return reply.send(rendered.bytes);
    },
  );
}
