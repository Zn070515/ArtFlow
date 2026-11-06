import { Type, type Static } from "@sinclair/typebox";

/**
 * Transport contracts for Activity Packs. The domain owns pack resolution;
 * this file only fixes the JSON shape Studio and the API exchange.
 */
export const PackQuestionSchema = Type.Object(
  {
    id: Type.String({ pattern: "^[a-z][a-z0-9-]*$", maxLength: 80 }),
    prompt: Type.String({ minLength: 1, maxLength: 300 }),
    capability: Type.String({ pattern: "^[a-z][a-z0-9_-]*$", maxLength: 80 }),
    default: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const ActivityPackSchema = Type.Object(
  {
    identity: Type.String({ pattern: "^[a-z][a-z0-9-]*$", maxLength: 80 }),
    version: Type.String({ minLength: 1, maxLength: 40 }),
    title: Type.String({ minLength: 1, maxLength: 200 }),
    baselineCapabilities: Type.Array(Type.String({ minLength: 1, maxLength: 80 }), {
      uniqueItems: true,
    }),
    questions: Type.Array(PackQuestionSchema),
  },
  { additionalProperties: false },
);

export const PackInstantiateBodySchema = Type.Object(
  {
    title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    answers: Type.Optional(Type.Record(Type.String({ minLength: 1 }), Type.Boolean())),
    enable: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 80 }), { uniqueItems: true }),
    ),
    disable: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 80 }), { uniqueItems: true }),
    ),
  },
  { additionalProperties: false },
);

export type PackQuestion = Static<typeof PackQuestionSchema>;
export type ActivityPackContract = Static<typeof ActivityPackSchema>;
export type PackInstantiateBody = Static<typeof PackInstantiateBodySchema>;
