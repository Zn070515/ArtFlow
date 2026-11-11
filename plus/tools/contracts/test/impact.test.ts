import { describe, expect, it } from "vitest";

import { buildGraphFromSources } from "../src/graph/build.js";
import { findStartNodes, formatImpactReport, impactOf } from "../src/graph/impact.js";
import type { SourceFile } from "../src/graph/schema.js";

const sources: SourceFile[] = [
  {
    path: "packages/runtime/src/command.ts",
    text: `export async function executeCommand<T>(db: unknown, meta: unknown, handler: () => Promise<T>): Promise<T> { return handler(); }`,
  },
  {
    path: "packages/runtime/src/voting-ticket-service.ts",
    text: `
import { executeCommand } from "./command.js";

export async function claimJudgeSeat(db: unknown, deps: unknown, input: { activityId: string; commandId: string }) {
  return executeCommand(db, {
    commandId: input.commandId,
    activityId: input.activityId,
    capability: "ticketing",
    commandType: "ticketing.judge_seat.claim",
    payload: {},
  }, async () => ({ body: { ok: true } }));
}
`,
  },
  {
    path: "packages/domain/src/capabilities/ticketing.ts",
    text: `
export const ticketingCapability = deepFreeze({
  manifest: {
    identity: "ticketing",
    version: "1",
    dependencies: [],
    conflicts: [],
    definitionSchemaVersion: 1,
    commands: ["ticketing.judge_seat.claim"],
    queries: [],
    events: [],
    permissions: ["ticket.manage"],
    surfaces: ["live"],
  },
});
`,
  },
  {
    path: "apps/api/src/routes/public.ts",
    text: `
import { claimJudgeSeat } from "../../../../packages/runtime/src/voting-ticket-service.js";
app.post("/api/judge-entry/claim", async () => claimJudgeSeat(db, deps, { activityId: "a", commandId: "c" }));
`,
  },
  {
    path: "apps/api/src/realtime-topics.ts",
    text: `export function topic() { return { namespace: "activity", async snapshot() { return null; } }; }`,
  },
];

describe("impact analysis", () => {
  it("finds the route, command, and capability from a changed provider symbol", () => {
    const built = buildGraphFromSources(sources);
    const report = impactOf(built, ["symbol:packages/runtime/src/voting-ticket-service.ts#claimJudgeSeat"]);
    const ids = report.nodes.map((item) => item.node.id);
    expect(ids).toContain("route:POST /api/judge-entry/claim");
    expect(ids).toContain("command:ticketing.judge_seat.claim");
    expect(ids).toContain("capability:ticketing");
  });

  it("selects a start node by kind and value", () => {
    const built = buildGraphFromSources(sources);
    const starts = findStartNodes(built, { kind: "command", value: "ticketing.judge_seat.claim" });
    expect(starts.map((node) => node.id)).toEqual(["command:ticketing.judge_seat.claim"]);
  });

  it("formats a report with the start node and its consumers", () => {
    const built = buildGraphFromSources(sources);
    const report = impactOf(built, ["symbol:packages/runtime/src/voting-ticket-service.ts#claimJudgeSeat"]);
    const markdown = formatImpactReport(report, "claimJudgeSeat");
    expect(markdown).toContain("# Consumer impact: claimJudgeSeat");
    expect(markdown).toContain("POST /api/judge-entry/claim");
  });
});
