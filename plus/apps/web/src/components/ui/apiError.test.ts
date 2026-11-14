import { describe, expect, it } from "vitest";

import { ApiError } from "../../api/client.js";
import { apiErrorText } from "./apiError.js";

describe("apiErrorText", () => {
  it("prefers the caller's conflict sentence for a 409", () => {
    expect(
      apiErrorText(new ApiError(409, "STALE_REVISION", "stale"), "fallback", "请刷新后重试"),
    ).toBe("请刷新后重试");
  });

  it("uses the server message for other API failures", () => {
    expect(
      apiErrorText(new ApiError(400, "INVALID_INPUT", "bad input"), "fallback", "conflict"),
    ).toBe("bad input");
  });

  it("falls back for values that are not errors", () => {
    expect(apiErrorText("not-an-error", "fallback", "conflict")).toBe("fallback");
  });
});
