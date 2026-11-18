import { describe, expect, it } from "vitest";

import {
  compileMaterialsDefinition,
  createMaterialsDefinition,
  MAX_MATERIAL_UPLOAD_BYTES,
} from "../src/index.js";

describe("materials upload ceiling", () => {
  it("accepts the 600 MiB ceiling and rejects anything above it", () => {
    const accepted = compileMaterialsDefinition(
      createMaterialsDefinition(MAX_MATERIAL_UPLOAD_BYTES, ["video"]),
    );
    expect(accepted.ok).toBe(true);

    const rejected = compileMaterialsDefinition(
      createMaterialsDefinition(MAX_MATERIAL_UPLOAD_BYTES + 1, ["video"]),
    );
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.issues.map((issue) => issue.code)).toContain("MAX_BYTES_TOO_LARGE");
    }
  });

  it("still rejects a non-positive size", () => {
    const result = compileMaterialsDefinition(createMaterialsDefinition(0, ["video"]));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.code)).toContain("MAX_BYTES_INVALID");
    }
  });
});
