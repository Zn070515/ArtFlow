import { type Static, Type } from "@sinclair/typebox";

/**
 * Journey specs are data, not scripts. The runner maps each action to an API
 * call; keeping the action list here lets the contract tools reject a spec
 * that names an action nothing implements.
 */
export const JOURNEY_ACTIONS = [
  "create-activity",
  "activate-activity",
  "compile-definition",
  "release-definition",
  "start-registration",
  "answer-question",
  "submit-registration",
  "review-registration",
  "finalize-roster",
] as const;

export type JourneyAction = (typeof JOURNEY_ACTIONS)[number];

export const JourneyStepSchema = Type.Object(
  {
    action: Type.Union(JOURNEY_ACTIONS.map((action) => Type.Literal(action))),
    title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    key: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
    value: Type.Optional(Type.String({ maxLength: 2000 })),
    status: Type.Optional(
      Type.Union([Type.Literal("approved"), Type.Literal("rejected"), Type.Literal("need_supplement")]),
    ),
  },
  { additionalProperties: false },
);

export const JourneySpecSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 100 }),
    description: Type.Optional(Type.String({ maxLength: 500 })),
    actor: Type.Union([Type.Literal("organizer"), Type.Literal("participant")]),
    steps: Type.Array(JourneyStepSchema, { minItems: 1 }),
  },
  { additionalProperties: false },
);

export type JourneyStep = Static<typeof JourneyStepSchema>;
export type JourneySpec = Static<typeof JourneySpecSchema>;
