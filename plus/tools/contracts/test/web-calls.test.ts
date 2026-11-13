import { describe, expect, it } from "vitest";

import { extractWebCalls } from "../src/graph/ui.js";
import type { SourceFile } from "../src/graph/schema.js";

function file(text: string, path = "apps/web/src/components/sample.tsx"): SourceFile {
  return { path, text };
}

describe("web call extraction", () => {
  it("detects apiFetch and fetch with their methods", () => {
    const calls = extractWebCalls([
      file(`
export async function load(activityId: string) {
  await apiFetch<{ ok: boolean }>(\`/api/activities/\${activityId}/registrations\`, {
    method: "POST",
    body: "{}",
  });
  await fetch("/api/activities/x/roster");
}
`),
    ]);
    expect(calls).toEqual([
      expect.objectContaining({ method: "POST", path: "/api/activities/:param/registrations" }),
      expect.objectContaining({ method: "GET", path: "/api/activities/x/roster" }),
    ]);
  });

  it("detects anchor downloads as GET consumers", () => {
    const calls = extractWebCalls([
      file(`
export function Download({ activityId, materialId }: { activityId: string; materialId: string }) {
  return (
    <a href={\`/api/activities/\${activityId}/materials/\${materialId}/content\`}>download</a>
  );
}
`),
    ]);
    expect(calls).toEqual([
      expect.objectContaining({ method: "GET", path: "/api/activities/:param/materials/:param/content" }),
    ]);
  });

  it("ignores non-API links and external URLs", () => {
    const calls = extractWebCalls([
      file(`export function Links() { return <a href="https://example.com/api/x">x</a>; }`),
    ]);
    expect(calls).toEqual([]);
  });
});
