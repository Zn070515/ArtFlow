import { describe, expect, it } from "vitest";

import { buildGraphFromSources } from "../../src/graph/build.js";
import type { SourceFile } from "../../src/graph/schema.js";
import { findUnreferencedMutationRoutes, routeMatches } from "../../src/graph/ui.js";

const sources: SourceFile[] = [
  {
    path: "apps/api/src/routes/tasks.ts",
    text: `
app.post("/api/activities/:id/tasks/sync", { schema: {} }, async () => ({ ok: true }));
app.post("/api/activities/:id/competition/podium/recompute", async () => ({ ok: true }));
`,
  },
  {
    path: "apps/web/src/api/tasks.ts",
    text: `
export function syncTasks(activityId: string) {
  return apiFetch(\`/api/activities/\${encodeURIComponent(activityId)}/tasks/sync\`, {
    method: "POST",
    body: "{}",
  });
}
`,
  },
];

describe("web API consumer gaps", () => {
  it("matches Fastify parameters against template-literal segments", () => {
    expect(routeMatches(
      "/api/activities/:id/tasks/sync",
      "/api/activities/:param/tasks/sync",
    )).toBe(true);
    expect(routeMatches(
      "/api/activities/:id/tasks/sync",
      "/api/activities/:param/competition/podium/recompute",
    )).toBe(false);
  });

  it("links a web API call to its route", () => {
    const graph = buildGraphFromSources(sources);
    expect(graph.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        from: "file:apps/web/src/api/tasks.ts",
        to: "route:POST /api/activities/:id/tasks/sync",
        kind: "consumes-route",
      }),
    ]));
  });

  it("reports mutation routes with no web caller", () => {
    const graph = buildGraphFromSources(sources);
    const gaps = findUnreferencedMutationRoutes(graph);
    expect(gaps.map((gap) => `${gap.method} ${gap.path}`)).toEqual([
      "POST /api/activities/:id/competition/podium/recompute",
    ]);
  });
});
