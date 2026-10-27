import { Type, type Static } from "@sinclair/typebox";

import { LIMITS, PROTOCOL_VERSION, REALTIME_ERROR_CODES } from "./version.js";

const Version = Type.Literal(PROTOCOL_VERSION);
const RequestId = Type.String({ pattern: "^[A-Za-z0-9_-]{1,64}$" });
const Topic = Type.String({ minLength: 3, maxLength: LIMITS.maxTopicLength });

export const SubscribeMessageSchema = Type.Object(
  { v: Version, type: Type.Literal("subscribe"), id: RequestId, topic: Topic },
  { additionalProperties: false },
);

export const UnsubscribeMessageSchema = Type.Object(
  { v: Version, type: Type.Literal("unsubscribe"), id: RequestId, topic: Topic },
  { additionalProperties: false },
);

export const PingMessageSchema = Type.Object(
  { v: Version, type: Type.Literal("ping"), at: Type.Integer({ minimum: 0 }) },
  { additionalProperties: false },
);

export const ClientMessageSchema = Type.Union([
  SubscribeMessageSchema,
  UnsubscribeMessageSchema,
  PingMessageSchema,
]);

export const HelloMessageSchema = Type.Object(
  {
    v: Version,
    type: Type.Literal("hello"),
    clientPingIntervalMs: Type.Integer({ minimum: 1000 }),
    pongTimeoutMs: Type.Integer({ minimum: 1000 }),
    maxSubscriptions: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);

export const SubscribedMessageSchema = Type.Object(
  {
    v: Version,
    type: Type.Literal("subscribed"),
    id: RequestId,
    topic: Topic,
    seq: Type.Integer({ minimum: 0 }),
    data: Type.Unknown(),
  },
  { additionalProperties: false },
);

export const UpdateMessageSchema = Type.Object(
  {
    v: Version,
    type: Type.Literal("update"),
    topic: Topic,
    seq: Type.Integer({ minimum: 0 }),
    data: Type.Unknown(),
  },
  { additionalProperties: false },
);

export const UnsubscribedMessageSchema = Type.Object(
  { v: Version, type: Type.Literal("unsubscribed"), id: RequestId, topic: Topic },
  { additionalProperties: false },
);

export const ErrorMessageSchema = Type.Object(
  {
    v: Version,
    type: Type.Literal("error"),
    id: Type.Optional(RequestId),
    code: Type.Union(REALTIME_ERROR_CODES.map((code) => Type.Literal(code))),
    message: Type.String({ maxLength: 500 }),
  },
  { additionalProperties: false },
);

export const PongMessageSchema = Type.Object(
  { v: Version, type: Type.Literal("pong"), at: Type.Integer({ minimum: 0 }) },
  { additionalProperties: false },
);

export const ServerMessageSchema = Type.Union([
  HelloMessageSchema,
  SubscribedMessageSchema,
  UpdateMessageSchema,
  UnsubscribedMessageSchema,
  ErrorMessageSchema,
  PongMessageSchema,
]);

export type ClientMessage = Static<typeof ClientMessageSchema>;
export type ServerMessage = Static<typeof ServerMessageSchema>;
export type SubscribeMessage = Static<typeof SubscribeMessageSchema>;
export type UnsubscribeMessage = Static<typeof UnsubscribeMessageSchema>;
export type PingMessage = Static<typeof PingMessageSchema>;
export type HelloMessage = Static<typeof HelloMessageSchema>;
export type SubscribedMessage = Static<typeof SubscribedMessageSchema>;
export type UpdateMessage = Static<typeof UpdateMessageSchema>;
export type ErrorMessage = Static<typeof ErrorMessageSchema>;
export type PongMessage = Static<typeof PongMessageSchema>;
