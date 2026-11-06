import { Type, type Static } from "@sinclair/typebox";

/**
 * The transport envelope around one command.
 *
 * `actor` is deliberately absent: the HTTP layer derives it from the session,
 * never from the body. `payload` is typed by the individual command contract;
 * this envelope only carries the authority context.
 */
export const CommandEnvelopeSchema = Type.Object(
  {
    commandId: Type.String({ minLength: 1, maxLength: 100 }),
    activityId: Type.String({ minLength: 1, maxLength: 100 }),
    capability: Type.String({ minLength: 1, maxLength: 100 }),
    expectedRevision: Type.Optional(Type.Integer({ minimum: 0 })),
    scope: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
    payload: Type.Unknown(),
  },
  { additionalProperties: false },
);

export type CommandEnvelope = Static<typeof CommandEnvelopeSchema>;
