export const PROTOCOL_VERSION = 1 as const;

export const LIMITS = {
  maxSubscriptions: 32,
  maxClientMessageBytes: 4096,
  maxServerBufferedBytes: 1024 * 1024,
  subscribePerSecond: 10,
  maxTopicLength: 160,
} as const;

export const HEARTBEAT = {
  clientPingIntervalMs: 25000,
  pongTimeoutMs: 10000,
  serverPingIntervalMs: 30000,
  serverPongTimeoutMs: 10000,
} as const;

export const CLOSE_CODES = {
  normal: 1000,
  protocol: 4400,
  unauthenticated: 4401,
  forbidden: 4403,
  notFound: 4404,
  heartbeatTimeout: 4408,
  limit: 4429,
} as const;

export const REALTIME_ERROR_CODES = [
  "PROTOCOL_INVALID",
  "UNKNOWN_TOPIC",
  "FORBIDDEN",
  "NOT_FOUND",
  "ALREADY_SUBSCRIBED",
  "LIMIT_EXCEEDED",
  "RATE_LIMITED",
  "SNAPSHOT_UNAVAILABLE",
  "VERSION_MISMATCH",
] as const;

export type RealtimeErrorCode = (typeof REALTIME_ERROR_CODES)[number];
