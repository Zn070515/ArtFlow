import { describe, expect, it } from "vitest";

import { declaredStageKey } from "./publishingStage.js";

describe("declaredStageKey", () => {
  it("uses the released stage instead of an undeclared vote_result key", () => {
    expect(declaredStageKey([{ key: "final_podium" }], "vote_result")).toBe("final_podium");
    expect(declaredStageKey([{ key: "vote_result" }], "vote_result")).toBe("vote_result");
    expect(declaredStageKey([], "vote_result")).toBeNull();
  });
});
