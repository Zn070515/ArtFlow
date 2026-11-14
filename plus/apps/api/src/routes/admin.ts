import {
  AccountListQuerySchema,
  AccountListResponseSchema,
  AccountParamsSchema,
  AccountResponseSchema,
  CreateAccountBodySchema,
  InviteAccountBodySchema,
  InviteAccountResponseSchema,
  InviteRevokeResponseSchema,
  RevokeSessionsResponseSchema,
  UpdateAccountBodySchema,
  type AccountListQuery,
  type CreateAccountBody,
  type InviteAccountBody,
  type UpdateAccountBody,
} from "@artflow-plus/contracts";
import {
  createAccount,
  createAccountInvite,
  listAccounts,
  revokeAccountInvite,
  revokeAccountSessions,
  updateAccount,
} from "@artflow-plus/runtime";

import type { ApiContext } from "../http/context.js";

export function registerAdminRoutes(ctx: ApiContext): void {
  const { app, db, requestActor } = ctx;

  app.get(
    "/api/admin/accounts",
    {
      schema: {
        querystring: AccountListQuerySchema,
        response: { 200: AccountListResponseSchema },
      },
      config: { access: "admin" },
    },
    async (request) => {
      const query = request.query as AccountListQuery;
      return listAccounts(db, await requestActor(request), {
        ...(query.includeParticipants === undefined
          ? {}
          : { includeParticipants: query.includeParticipants }),
        ...(query.limit === undefined ? {} : { limit: query.limit }),
        ...(query.offset === undefined ? {} : { offset: query.offset }),
      });
    },
  );

  app.post(
    "/api/admin/accounts",
    {
      schema: {
        body: CreateAccountBodySchema,
        response: { 201: AccountResponseSchema },
      },
    },
    async (request, reply) => {
      const body = request.body as CreateAccountBody;
      const account = await createAccount(db, await requestActor(request), body);
      return reply.status(201).send({ account });
    },
  );

  app.put(
    "/api/admin/accounts/:username",
    {
      schema: {
        params: AccountParamsSchema,
        body: UpdateAccountBodySchema,
        response: { 200: AccountResponseSchema },
      },
    },
    async (request) => {
      const { username } = request.params as { username: string };
      const body = request.body as UpdateAccountBody;
      return { account: await updateAccount(db, await requestActor(request), username, body) };
    },
  );

  app.post(
    "/api/admin/accounts/invites",
    {
      schema: {
        body: InviteAccountBodySchema,
        response: { 201: InviteAccountResponseSchema },
      },
    },
    async (request, reply) => {
      const body = request.body as InviteAccountBody;
      const invite = await createAccountInvite(db, await requestActor(request), body);
      return reply.status(201).send(invite);
    },
  );

  app.delete(
    "/api/admin/accounts/:username/invite",
    {
      schema: {
        params: AccountParamsSchema,
        response: { 200: InviteRevokeResponseSchema },
      },
    },
    async (request) => {
      const { username } = request.params as { username: string };
      return revokeAccountInvite(db, await requestActor(request), username);
    },
  );

  app.post(
    "/api/admin/accounts/:username/revoke-sessions",
    {
      schema: {
        params: AccountParamsSchema,
        response: { 200: RevokeSessionsResponseSchema },
      },
    },
    async (request) => {
      const { username } = request.params as { username: string };
      return revokeAccountSessions(db, await requestActor(request), username);
    },
  );
}
