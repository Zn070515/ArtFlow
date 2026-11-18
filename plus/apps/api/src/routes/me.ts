import type { ApiContext } from "../http/context.js";
import { MarkNotificationsReadBody } from "../http/schemas.js";
import { getParticipantCenter, markParticipantNotificationsRead } from "@artflow-plus/runtime";

export function registerMeRoutes(ctx: ApiContext): void {
  const { app, db, requestDeps } = ctx;

  app.get(
    "/api/me",
    { config: { access: "session" } },
    async (request) => getParticipantCenter(db, await requestDeps(request)),
  );

  app.post(
    "/api/me/notifications/read",
    { schema: { body: MarkNotificationsReadBody } },
    async (request) => {
      const body = request.body as { keys: string[] };
      return markParticipantNotificationsRead(db, await requestDeps(request), body.keys);
    },
  );
}
