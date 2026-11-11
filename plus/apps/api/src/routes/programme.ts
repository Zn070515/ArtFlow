import type { ApiContext } from "../http/context.js";
import { readHostProgramme, readPublicProgramme } from "@artflow-plus/runtime";
import { Type } from "@sinclair/typebox";

import { ActivityParams } from "../http/schemas.js";

const PublicProgrammeParams = Type.Object(
  { publicCode: Type.String({ minLength: 1, maxLength: 100 }) },
  { additionalProperties: false },
);

export function registerProgrammeRoutes(ctx: ApiContext): void {
  const { app, db } = ctx;

  app.get(
    "/api/public/programme/:publicCode",
    { schema: { params: PublicProgrammeParams }, config: { access: "public" } },
    async (request, reply) => {
      const { publicCode } = request.params as { publicCode: string };
      reply.header("cache-control", "no-store");
      return readPublicProgramme(db, publicCode);
    },
  );

  app.get(
    "/api/activities/:id/programme",
    { schema: { params: ActivityParams }, config: { access: "session" } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      reply.header("cache-control", "no-store");
      return readHostProgramme(db, await ctx.requestDeps(request), id);
    },
  );
}
