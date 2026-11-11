import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { compareBaseline, emptyBaseline } from "../../src/audit/baseline.js";
import type { TestGap } from "../../src/audit/gaps.js";
import {
  deployManifestGaps,
  docDriftGaps,
  invariantCoverageGaps,
  manifestGaps,
  uiGaps,
} from "../../src/audit/gaps.js";
import { buildGraphFromSources } from "../../src/graph/build.js";
import type { SourceFile } from "../../src/graph/schema.js";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "artflow-gap-audit-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("gap audit", () => {
  it("fails new gaps and stale baseline entries", () => {
    const gaps: TestGap[] = [
      { id: "ui-route:POST /api/new", kind: "ui-route", subject: "POST /api/new", detail: "no caller" },
    ];
    expect(compareBaseline(gaps, emptyBaseline()).newGaps).toHaveLength(1);
    const accepted = {
      version: 1 as const,
      accepted: [{ id: "ui-route:POST /api/new", reason: "known" }],
    };
    expect(compareBaseline(gaps, accepted)).toEqual({ newGaps: [], stale: [] });
    expect(compareBaseline([], accepted).stale).toHaveLength(1);
  });

  it("finds a mutation route with no web caller", () => {
    const graph = buildGraphFromSources([
      {
        path: "apps/api/src/routes/probe.ts",
        text: `app.post("/api/activities/:id/probe", async () => ({ ok: true }));`,
      },
    ]);
    expect(uiGaps(graph).map((gap) => gap.id)).toEqual([
      "ui-route:POST /api/activities/:id/probe",
    ]);
  });

  it("finds commands and events without providers or consumers", () => {
    const graph = buildGraphFromSources([
      {
        path: "packages/domain/src/capabilities/probe.ts",
        text: `
export const probe = deepFreeze({
  manifest: {
    identity: "probe",
    version: "1",
    dependencies: [],
    conflicts: [],
    definitionSchemaVersion: 1,
    commands: ["probe.missing"],
    queries: [],
    events: ["ProbeMissing"],
    permissions: [],
    surfaces: ["ops"],
  },
});
`,
      },
    ]);
    const ids = manifestGaps(graph).map((gap) => gap.id);
    expect(ids).toContain("manifest:command-no-provider:probe.missing");
    expect(ids).toContain("manifest:event-no-producer:ProbeMissing");
    expect(ids).toContain("manifest:event-no-consumer:ProbeMissing");
  });

  it("finds stale active documentation", async () => {
    const root = await tempRoot();
    await mkdir(path.join(root, "docs"), { recursive: true });
    await writeFile(
      path.join(root, "docs", "deployment-production.md"),
      "Run Gunicorn and open /register/admin/.",
      "utf8",
    );
    const ids = docDriftGaps(root).map((gap) => gap.id);
    expect(ids).toContain("doc-drift:docs/deployment-production.md:Gunicorn");
    expect(ids).toContain("doc-drift:docs/deployment-production.md:/register/admin/");
  });

  it("finds the PostgreSQL 18 compose mount path", async () => {
    const root = await tempRoot();
    await mkdir(path.join(root, "deploy"), { recursive: true });
    await writeFile(
      path.join(root, "deploy", "compose.production.yml"),
      "volumes:\n  plus_postgres_data:/var/lib/postgresql/data\n",
      "utf8",
    );
    expect(deployManifestGaps(root).map((gap) => gap.id)).toEqual([
      "deploy-manifest:compose.plus-db.volume-path",
    ]);
  });

  it("finds invariants with no test reference", async () => {
    const root = await tempRoot();
    await mkdir(path.join(root, "docs", "invariants"), { recursive: true });
    await mkdir(path.join(root, "plus", "packages", "domain", "test"), { recursive: true });
    await writeFile(
      path.join(root, "docs", "invariants", "probe.md"),
      "## AUTH-999\n## LIFE-999\n",
      "utf8",
    );
    await writeFile(
      path.join(root, "plus", "packages", "domain", "test", "probe.test.ts"),
      "it('covers AUTH-999', () => {});\n",
      "utf8",
    );
    expect(invariantCoverageGaps(root).map((gap) => gap.id)).toEqual([
      "invariant-coverage:LIFE-999",
    ]);
  });
});
