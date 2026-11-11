import { describe, expect, it } from "vitest";

import { validateApiOnly } from "../src/audit/api-only.js";
import type { ConsumerGraph } from "../src/graph/schema.js";

const graph = {
  nodes: [
    { id: "route:POST /api/activities/:id/runtime-facts", kind: "route", name: "POST /api/activities/:id/runtime-facts" },
    { id: "route:POST /api/activities/:id/materials", kind: "route", name: "POST /api/activities/:id/materials" },
  ],
  edges: [],
} as unknown as ConsumerGraph;

describe("api-only declarations", () => {
  it("accepts a live route with a reason", () => {
    expect(
      validateApiOnly(
        [{ method: "POST", path: "/api/activities/:id/runtime-facts", reason: "test seam" }],
        graph,
      ),
    ).toEqual([]);
  });

  it("rejects unknown routes, empty reasons and duplicates", () => {
    const problems = validateApiOnly(
      [
        { method: "POST", path: "/api/activities/:id/missing", reason: "gone" },
        { method: "POST", path: "/api/activities/:id/materials", reason: "  " },
        { method: "POST", path: "/api/activities/:id/materials", reason: "duplicate" },
      ],
      graph,
    );
    expect(problems).toContain("POST /api/activities/:id/missing: no such mutation route in the current tree.");
    expect(problems).toContain("POST /api/activities/:id/materials: reason must not be empty.");
    expect(problems).toContain("POST /api/activities/:id/materials: declared more than once.");
  });
});
