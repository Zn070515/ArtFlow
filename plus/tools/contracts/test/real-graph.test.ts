import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildConsumerGraph } from "../src/graph/build.js";
import { loadDynamicDependencies } from "../src/graph/dynamic.js";
import { impactOf } from "../src/graph/impact.js";

const root = path.resolve(import.meta.dirname, "../../..");
const dynamic = loadDynamicDependencies(path.resolve(import.meta.dirname, "../dynamic-dependencies.json"));
const graph = buildConsumerGraph(root, dynamic);

function edge(from: string, to: string, kind: string): boolean {
  return graph.edges.some((item) => item.from === from && item.to === to && item.kind === kind);
}

describe("the real ArtFlow consumer graph", () => {
  it("builds without unresolved references", () => {
    expect(graph.unresolved).toEqual([]);
  });

  it("connects claimJudgeSeat to its command, event, and route", () => {
    const provider = "symbol:packages/runtime/src/voting-ticket-service.ts#claimJudgeSeat";
    expect(edge(provider, "command:ticketing.judge_seat.claim", "invokes-command")).toBe(true);
    expect(edge(provider, "event:JudgeSeatClaimed", "emits")).toBe(true);
    expect(edge("route:POST /api/judge-entry/claim", provider, "serves")).toBe(true);
  });

  it("connects the voting realtime topic to its read model", () => {
    expect(edge(
      "topic:voting",
      "symbol:packages/runtime/src/voting-read-service.ts#readVotingSessionsState",
      "subscribes",
    )).toBe(true);
  });

  it("reports the route and capability from a judge claim change", () => {
    const report = impactOf(
      graph,
      ["symbol:packages/runtime/src/voting-ticket-service.ts#claimJudgeSeat"],
    );
    const ids = report.nodes.map((item) => item.node.id);
    expect(ids).toContain("route:POST /api/judge-entry/claim");
    expect(ids).toContain("capability:ticketing");
  });

  it("keeps the declared event consumers connected", () => {
    expect(edge(
      "symbol:packages/runtime/src/outbox-relay.ts#applyToLiveProjection",
      "event:BallotSubmitted",
      "consumes",
    )).toBe(true);
  });
});
