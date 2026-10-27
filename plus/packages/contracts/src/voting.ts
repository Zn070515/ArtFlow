import { Type, type Static } from "@sinclair/typebox";

export const OpenVoteSessionBodySchema = Type.Object(
  {
    sessionId: Type.String({ minLength: 1, maxLength: 100 }),
    scope: Type.String({ pattern: "^[a-z][a-z0-9_-]*$", maxLength: 100 }),
    candidateIds: Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { minItems: 1, uniqueItems: true }),
  },
  { additionalProperties: false },
);

const TicketIdentitySchema = Type.Object(
  { type: Type.Literal("ticket") },
  { additionalProperties: false },
);
const BrowserIdentitySchema = Type.Object(
  { type: Type.Literal("browser") },
  { additionalProperties: false },
);
const AnonymousIdentitySchema = Type.Object(
  { type: Type.Literal("anonymous") },
  { additionalProperties: false },
);

export const SubmitBallotBodySchema = Type.Object(
  {
    scope: Type.String({ pattern: "^[a-z][a-z0-9_-]*$", maxLength: 100 }),
    optionIds: Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { minItems: 1, uniqueItems: true }),
    identity: Type.Union([TicketIdentitySchema, BrowserIdentitySchema, AnonymousIdentitySchema]),
  },
  { additionalProperties: false },
);

export const CloseVoteSessionBodySchema = Type.Object(
  {
    scope: Type.String({ pattern: "^[a-z][a-z0-9_-]*$", maxLength: 100 }),
    expectedRevision: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const JudgeEntryBodySchema = Type.Object(
  {
    publicCode: Type.String({ minLength: 1, maxLength: 100 }),
    capability: Type.Union([Type.String({ minLength: 1, maxLength: 300 }), Type.Null()]),
  },
  { additionalProperties: false },
);

export const TicketCredentialBodySchema = Type.Object(
  { credential: Type.String({ minLength: 1, maxLength: 300 }) },
  { additionalProperties: false },
);

export const ReasonBodySchema = Type.Object(
  { reason: Type.String({ minLength: 1, maxLength: 2000 }) },
  { additionalProperties: false },
);

export type OpenVoteSessionBody = Static<typeof OpenVoteSessionBodySchema>;
export type SubmitBallotBody = Static<typeof SubmitBallotBodySchema>;
export type CloseVoteSessionBody = Static<typeof CloseVoteSessionBodySchema>;
export type JudgeEntryBody = Static<typeof JudgeEntryBodySchema>;

export const VotingCandidateSnapshotSchema = Type.Object(
  {
    optionId: Type.String({ minLength: 1, maxLength: 100 }),
    candidateId: Type.String({ minLength: 1, maxLength: 100 }),
    ordinal: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const VotingSessionSnapshotSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 100 }),
    status: Type.Union([Type.Literal("open"), Type.Literal("closed")]),
    mode: Type.String({ minLength: 1, maxLength: 20 }),
    revision: Type.Integer({ minimum: 0 }),
    candidateCount: Type.Integer({ minimum: 0 }),
    candidates: Type.Array(VotingCandidateSnapshotSchema),
    live: Type.Union([
      Type.Null(),
      Type.Object(
        {
          seq: Type.Integer({ minimum: 0 }),
          counts: Type.Record(Type.String(), Type.Integer({ minimum: 0 })),
          lastEventType: Type.String({ minLength: 1, maxLength: 100 }),
        },
        { additionalProperties: false },
      ),
    ]),
  },
  { additionalProperties: false },
);

export const VotingSessionsSnapshotSchema = Type.Object(
  {
    activityId: Type.String({ minLength: 1, maxLength: 100 }),
    sessions: Type.Array(VotingSessionSnapshotSchema),
  },
  { additionalProperties: false },
);

export type VotingSessionsSnapshot = Static<typeof VotingSessionsSnapshotSchema>;
