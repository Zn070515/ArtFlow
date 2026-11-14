import {
  AccountParamsSchema,
  CreateAccountBodySchema,
  UpdateAccountBodySchema,
  type CreateAccountBody,
  type UpdateAccountBody,
} from "@artflow-plus/contracts";
import {
  createAccount,
  listAccounts,
  revokeAccountSessions,
  updateAccount,
} from "@artflow-plus/runtime";

import type { ApiContext } from "../http/context.js";

export function registerAdminRoutes(ctx: ApiContext): void {
  const { app, db, requestActor } = ctx;

  app.get(
    "/api/admin/accounts",
    { config: { access: "admin" } },
    async (request) => ({
      accounts: await listAccounts(db, await requestActor(request)),
    }),
  );

  app.post(
    "/api/admin/accounts",
    { schema: { body: CreateAccountBodySchema } },
    async (request, reply) => {
      const body = request.body as CreateAccountBody;
      const account = await createAccount(db, await requestActor(request), body);
      return reply.status(201).send({ account });
    },
  );

  app.put(
    "/api/admin/accounts/:username",
    { schema: { params: AccountParamsSchema, body: UpdateAccountBodySchema } },
    async (request) => {
      const { username } = request.params as { username: string };
      const body = request.body as UpdateAccountBody;
      return { account: await updateAccount(db, await requestActor(request), username, body) };
    },
  );

  app.post(
    "/api/admin/accounts/:username/revoke-sessions",
    { schema: { params: AccountParamsSchema } },
    async (request) => {
      const { username } = request.params as { username: string };
      return revokeAccountSessions(db, await requestActor(request), username);
    },
  );
}
