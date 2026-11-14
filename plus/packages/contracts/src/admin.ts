import { Type, type Static } from "@sinclair/typebox";

export const AccountParamsSchema = Type.Object(
  { username: Type.String({ minLength: 1, maxLength: 100 }) },
  { additionalProperties: false },
);

const AccountRolesSchema = Type.Array(
  Type.String({ minLength: 1, maxLength: 80 }),
  { uniqueItems: true },
);
const AccountPermissionsSchema = Type.Array(
  Type.String({ minLength: 1, maxLength: 120 }),
  { uniqueItems: true },
);

export const CreateAccountBodySchema = Type.Object(
  {
    username: Type.String({
      minLength: 3,
      maxLength: 64,
      pattern: "^[A-Za-z0-9_.-]+$",
    }),
    password: Type.String({ minLength: 8, maxLength: 128 }),
    roles: AccountRolesSchema,
    permissions: AccountPermissionsSchema,
  },
  { additionalProperties: false },
);

export const UpdateAccountBodySchema = Type.Object(
  {
    roles: Type.Optional(AccountRolesSchema),
    permissions: Type.Optional(AccountPermissionsSchema),
    active: Type.Optional(Type.Boolean()),
    password: Type.Optional(Type.String({ minLength: 8, maxLength: 128 })),
  },
  { additionalProperties: false },
);

export const AccountSummarySchema = Type.Object(
  {
    username: Type.String(),
    actorId: Type.String(),
    roles: Type.Array(Type.String()),
    permissions: Type.Array(Type.String()),
    active: Type.Boolean(),
    createdAt: Type.String(),
  },
  { additionalProperties: false },
);

export const AccountListResponseSchema = Type.Object(
  { accounts: Type.Array(AccountSummarySchema) },
  { additionalProperties: false },
);

export type CreateAccountBody = Static<typeof CreateAccountBodySchema>;
export type UpdateAccountBody = Static<typeof UpdateAccountBodySchema>;
export type AccountParams = Static<typeof AccountParamsSchema>;
export type AccountSummary = Static<typeof AccountSummarySchema>;
