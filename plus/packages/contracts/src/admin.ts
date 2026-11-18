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
    email: Type.Optional(Type.String({ maxLength: 320, pattern: "^[^@]+@[^@]+$" })),
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
    email: Type.Optional(Type.String({ maxLength: 320, pattern: "^[^@]+@[^@]+$" })),
    resetMfa: Type.Optional(Type.Boolean()),
    expectedRevision: Type.Integer({ minimum: 0 }),
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
    invited: Type.Boolean(),
    accessRevision: Type.Integer({ minimum: 0 }),
    createdAt: Type.String(),
    email: Type.Optional(Type.String()),
    mfaEnabled: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const AccountListResponseSchema = Type.Object(
  {
    accounts: Type.Array(AccountSummarySchema),
    total: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const AccountResponseSchema = Type.Object(
  { account: AccountSummarySchema },
  { additionalProperties: false },
);

export const RevokeSessionsResponseSchema = Type.Object(
  { revoked: Type.Integer({ minimum: 0 }) },
  { additionalProperties: false },
);

export const InviteAccountBodySchema = Type.Object(
  {
    username: Type.String({
      minLength: 3,
      maxLength: 64,
      pattern: "^[A-Za-z0-9_.-]+$",
    }),
    roles: AccountRolesSchema,
    permissions: AccountPermissionsSchema,
  },
  { additionalProperties: false },
);

export const InviteAccountResponseSchema = Type.Object(
  {
    account: AccountSummarySchema,
    token: Type.String({ minLength: 1 }),
    expiresAt: Type.String(),
  },
  { additionalProperties: false },
);

export const InvitePreviewBodySchema = Type.Object(
  { token: Type.String({ minLength: 1, maxLength: 200 }) },
  { additionalProperties: false },
);

export const InvitePreviewResponseSchema = Type.Object(
  { username: Type.String(), expiresAt: Type.String() },
  { additionalProperties: false },
);

export const ClaimInviteBodySchema = Type.Object(
  {
    token: Type.String({ minLength: 1, maxLength: 200 }),
    password: Type.String({ minLength: 12, maxLength: 128 }),
  },
  { additionalProperties: false },
);

export const InviteRevokeResponseSchema = Type.Object(
  { revoked: Type.Integer({ minimum: 0 }) },
  { additionalProperties: false },
);

export const AccountListQuerySchema = Type.Object(
  {
    includeParticipants: Type.Optional(Type.Boolean()),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
    offset: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

export type CreateAccountBody = Static<typeof CreateAccountBodySchema>;
export type UpdateAccountBody = Static<typeof UpdateAccountBodySchema>;
export type AccountParams = Static<typeof AccountParamsSchema>;
export type AccountSummary = Static<typeof AccountSummarySchema>;
export type AccountListQuery = Static<typeof AccountListQuerySchema>;
export type InviteAccountBody = Static<typeof InviteAccountBodySchema>;
export type InvitePreviewBody = Static<typeof InvitePreviewBodySchema>;
export type ClaimInviteBody = Static<typeof ClaimInviteBodySchema>;
