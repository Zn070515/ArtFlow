import { Value } from "@sinclair/typebox/value";
import { expect, it } from "vitest";

import {
  ActivityPackSchema,
  CapabilityManifestSchema,
  CommandEnvelopeSchema,
  DomainEventEnvelopeSchema,
  ErrorResponseSchema,
  errorResponse,
  PackInstantiateBodySchema,
} from "../src/index.js";

it("accepts a well-formed command envelope", () => {
  expect(
    Value.Check(CommandEnvelopeSchema, {
      commandId: "cmd-1",
      activityId: "act-1",
      capability: "competition",
      expectedRevision: 4,
      scope: "stage",
      payload: { note: "ok" },
    }),
  ).toBe(true);
});

it("refuses a command envelope without an idempotency id", () => {
  expect(
    Value.Check(CommandEnvelopeSchema, {
      activityId: "act-1",
      capability: "competition",
      payload: {},
    }),
  ).toBe(false);
});

it("refuses unknown fields rather than silently dropping them", () => {
  expect(
    Value.Check(CommandEnvelopeSchema, {
      commandId: "cmd-1",
      activityId: "act-1",
      capability: "competition",
      payload: {},
      actor: "forged",
    }),
  ).toBe(false);
});

it("requires an uppercase error code", () => {
  expect(
    Value.Check(ErrorResponseSchema, errorResponse("STALE_REVISION", "stale")),
  ).toBe(true);
  expect(Value.Check(ErrorResponseSchema, { code: "stale", message: "stale" })).toBe(false);
});

it("validates the event envelope", () => {
  expect(
    Value.Check(DomainEventEnvelopeSchema, {
      eventId: "evt-1",
      type: "ActivityActivated",
      occurredAt: "2026-10-19T10:00:00Z",
      activityId: "act-1",
      capability: "activity",
      aggregateId: "act-1",
      revision: 1,
      payload: {},
    }),
  ).toBe(true);
  expect(
    Value.Check(DomainEventEnvelopeSchema, {
      eventId: "evt-1",
      type: "activity_activated",
      occurredAt: "2026-10-19T10:00:00Z",
      activityId: "act-1",
      capability: "activity",
      aggregateId: "act-1",
      revision: 1,
      payload: {},
    }),
  ).toBe(false);
});

it("validates an activity pack and its guided questions", () => {
  const pack = {
    identity: "singer-competition",
    version: "1",
    title: "Singer Competition",
    baselineCapabilities: ["competition"],
    questions: [
      {
        id: "audience-voting",
        prompt: "是否需要观众投票？",
        capability: "voting",
        default: false,
      },
    ],
  };
  expect(Value.Check(ActivityPackSchema, pack)).toBe(true);
  expect(
    Value.Check(ActivityPackSchema, {
      ...pack,
      questions: [{ id: "broken", prompt: "no capability", default: true }],
    }),
  ).toBe(false);
  expect(Value.Check(ActivityPackSchema, { ...pack, extra: true })).toBe(false);
});

it("validates a pack instantiation body without accepting unknown fields", () => {
  expect(
    Value.Check(PackInstantiateBodySchema, {
      title: "2026 院十佳",
      answers: { "audience-voting": true },
      enable: ["archive"],
      disable: ["materials"],
    }),
  ).toBe(true);
  expect(
    Value.Check(PackInstantiateBodySchema, { answers: { "audience-voting": "yes" } }),
  ).toBe(false);
  expect(Value.Check(PackInstantiateBodySchema, { actor: "forged" })).toBe(false);
});

it("validates a capability manifest and its surfaces", () => {
  const manifest = {
    identity: "competition",
    version: "1",
    dependencies: ["registration"],
    conflicts: [],
    definitionSchemaVersion: 1,
    commands: ["competition.prepare_round"],
    queries: ["competition.current_round"],
    events: ["RoundPrepared"],
    permissions: ["staff"],
    surfaces: ["studio", "ops", "live"],
  };
  expect(Value.Check(CapabilityManifestSchema, manifest)).toBe(true);
  expect(
    Value.Check(CapabilityManifestSchema, { ...manifest, surfaces: ["unknown"] }),
  ).toBe(false);
  expect(
    Value.Check(CapabilityManifestSchema, { ...manifest, surfaces: [] }),
  ).toBe(false);
});
