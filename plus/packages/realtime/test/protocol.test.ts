import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
  ClientMessageSchema,
  ServerMessageSchema,
} from "../src/protocol/envelope.js";
import { createTopicRegistry, parseTopicString } from "../src/protocol/topic.js";

describe("realtime protocol", () => {
  it("accepts the three client messages and rejects unknown types", () => {
    expect(Value.Check(ClientMessageSchema, { v: 1, type: "subscribe", id: "r1", topic: "voting:act-1" })).toBe(true);
    expect(Value.Check(ClientMessageSchema, { v: 1, type: "unsubscribe", id: "r2", topic: "voting:act-1" })).toBe(true);
    expect(Value.Check(ClientMessageSchema, { v: 1, type: "ping", at: 1 })).toBe(true);
    expect(Value.Check(ClientMessageSchema, { v: 1, type: "command", id: "r3" })).toBe(false);
    expect(Value.Check(ClientMessageSchema, { v: 2, type: "ping", at: 1 })).toBe(false);
  });

  it("accepts server frames and rejects mismatched versions", () => {
    expect(Value.Check(ServerMessageSchema, { v: 1, type: "hello", clientPingIntervalMs: 25000, pongTimeoutMs: 10000, maxSubscriptions: 32 })).toBe(true);
    expect(Value.Check(ServerMessageSchema, { v: 1, type: "update", topic: "voting:a", seq: 2, data: {} })).toBe(true);
    expect(Value.Check(ServerMessageSchema, { v: 2, type: "update", topic: "voting:a", seq: 2, data: {} })).toBe(false);
  });

  it("validates the topic grammar", () => {
    expect(parseTopicString("voting:act_123")).toEqual({ namespace: "voting", rest: "act_123" });
    expect(parseTopicString("Voting:act")).toBeNull();
    expect(parseTopicString("voting:")).toBeNull();
    expect(parseTopicString("voting:act 1")).toBeNull();
    expect(parseTopicString("voting:act/1")).toBeNull();
  });

  it("rejects duplicate and invalid namespaces", () => {
    const topic = {
      namespace: "voting",
      parse: () => ({ activityId: "a", aggregateId: "a" }),
      authorize: async () => true,
      snapshot: async () => null,
    };
    expect(() => createTopicRegistry([topic, topic])).toThrow();
    expect(() => createTopicRegistry([{ ...topic, namespace: "Voting" }])).toThrow();
  });
});
