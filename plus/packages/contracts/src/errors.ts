import { Type, type Static } from "@sinclair/typebox";

/**
 * HTTP-visible error contract. The domain owns the code; the API only maps it.
 * Codes are upper snake case so clients can branch without parsing messages.
 */
export const ErrorResponseSchema = Type.Object(
  {
    code: Type.String({ pattern: "^[A-Z][A-Z0-9_]*$", maxLength: 80 }),
    message: Type.String({ minLength: 1, maxLength: 500 }),
    details: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);

export type ErrorResponse = Static<typeof ErrorResponseSchema>;

export function errorResponse(
  code: string,
  message: string,
  details?: unknown,
): ErrorResponse {
  return details === undefined ? { code, message } : { code, message, details };
}
