import { Type, type Static } from "@sinclair/typebox";

export const RegisterParticipantBodySchema = Type.Object(
  {
    username: Type.String({ minLength: 3, maxLength: 64, pattern: "^[A-Za-z0-9_.-]+$" }),
    password: Type.String({ minLength: 8, maxLength: 128 }),
  },
  { additionalProperties: false },
);

export type RegisterParticipantBody = Static<typeof RegisterParticipantBodySchema>;
