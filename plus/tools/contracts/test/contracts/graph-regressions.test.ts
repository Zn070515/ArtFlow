import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { deployManifestGaps, invariantCoverageGaps } from "../../src/audit/gaps.js";
import { enclosingSymbol } from "../../src/graph/scan.js";
import type { SymbolDecl } from "../../src/graph/scan.js";
import { checkWarningAllowlist } from "../../src/graph/warnings.js";

let roots: string[] = [];

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

function tempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "artflow-graph-"));
  roots.push(root);
  return root;
}

function write(root: string, relative: string, content: string): void {
  const file = path.join(root, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content, "utf8");
}

describe("graph regressions", () => {
  it("finds the closest symbol even when the symbol list is not index-sorted", () => {
    const symbols: SymbolDecl[] = [
      { name: "firstFunction", index: 10, exported: true },
      { name: "lastFunction", index: 100, exported: true },
      { name: "exportedConst", index: 50, exported: true },
    ];
    expect(enclosingSymbol(symbols, 120)?.name).toBe("lastFunction");
    expect(enclosingSymbol(symbols, 60)?.name).toBe("exportedConst");
    expect(enclosingSymbol(symbols, 5)).toBeUndefined();
  });

  it("rejects the PostgreSQL data subpath in the k8s manifest", () => {
    const wrong = tempRoot();
    write(wrong, "deploy/k8s/base/db.yaml", "volumeMounts:\n  - mountPath: /var/lib/postgresql/data\n");
    expect(deployManifestGaps(wrong)).toEqual([
      expect.objectContaining({ id: "deploy-manifest:k8s.plus-db.mount-path" }),
    ]);

    const correct = tempRoot();
    write(correct, "deploy/k8s/base/db.yaml", "volumeMounts:\n  - mountPath: /var/lib/postgresql\n");
    expect(deployManifestGaps(correct)).toEqual([]);
  });

  it("does not let a longer invariant id cover a prefix id", () => {
    // Synthetic ids only: a real id in this fixture would itself count as a
    // test reference in the production audit.
    const root = tempRoot();
    write(root, "docs/invariants/synthetic.md", "- AUTH-999 initial\n- AUTH-9990 terminal\n");
    write(root, "plus/tools/contracts/test/sample.test.ts", "// AUTH-9990 only\n");
    const gaps = invariantCoverageGaps(root);
    expect(gaps).toEqual([
      expect.objectContaining({ id: "invariant-coverage:AUTH-999" }),
    ]);
  });

  it("fails on an unaccepted warning and on a stale allowlist entry", () => {
    const allowlist = {
      version: 1 as const,
      accepted: [{ match: "known dynamic seam", reason: "declared dynamic dependency" }],
    };
    expect(checkWarningAllowlist(["known dynamic seam"], allowlist)).toEqual({
      unaccepted: [],
      stale: [],
    });
    expect(checkWarningAllowlist(["known dynamic seam: extra provider"], allowlist)).toEqual({
      unaccepted: ["known dynamic seam: extra provider"],
      stale: ["known dynamic seam"],
    });
    expect(checkWarningAllowlist(["brand new warning"], allowlist)).toEqual({
      unaccepted: ["brand new warning"],
      stale: ["known dynamic seam"],
    });
    expect(checkWarningAllowlist([], allowlist)).toEqual({
      unaccepted: [],
      stale: ["known dynamic seam"],
    });
  });
});
