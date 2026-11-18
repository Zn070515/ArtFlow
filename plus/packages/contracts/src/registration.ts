import { Type, type Static } from "@sinclair/typebox";

export const RegisterParticipantBodySchema = Type.Object(
  {
    username: Type.String({ minLength: 3, maxLength: 64, pattern: "^[A-Za-z0-9_.-]+$" }),
    password: Type.String({ minLength: 12, maxLength: 128 }),
    email: Type.Optional(Type.String({ maxLength: 320, pattern: "^[^@]+@[^@]+$" })),
  },
  { additionalProperties: false },
);

export type RegisterParticipantBody = Static<typeof RegisterParticipantBodySchema>;
