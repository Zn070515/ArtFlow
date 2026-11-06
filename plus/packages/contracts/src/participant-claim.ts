import { Type, type Static } from "@sinclair/typebox";

export const ParticipantClaimConsumeBodySchema = Type.Object(
  {
    token: Type.String({ minLength: 1, maxLength: 300 }),
    username: Type.Optional(Type.String({ minLength: 3, maxLength: 64, pattern: "^[A-Za-z0-9_.-]+$" })),
    password: Type.Optional(Type.String({ minLength: 8, maxLength: 128 })),
  },
  { additionalProperties: false },
);

export type ParticipantClaimConsumeBody = Static<typeof ParticipantClaimConsumeBodySchema>;
