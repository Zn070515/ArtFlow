import { describe, expect, it } from "vitest";

import {
  deriveOnsiteActions,
  displayCandidateName,
  formatFreshness,
  looksOpaqueId,
  matchCurrentProgramOrder,
} from "./onsiteActions.js";

const base = {
  siteStatus: "active" as const,
  hasCurrent: true,
  voteOpen: false,
  hasResults: false,
  registrationOpen: false,
};

describe("deriveOnsiteActions", () => {
  it("prioritizes an open vote over results and registration", () => {
    expect(deriveOnsiteActions({ ...base, voteOpen: true, hasResults: true, registrationOpen: true }))
      .toEqual({ live: true, primary: "vote" });
  });

  it("falls back to results when the vote is closed", () => {
    expect(deriveOnsiteActions({ ...base, hasResults: true, registrationOpen: true }))
      .toEqual({ live: true, primary: "results" });
  });

  it("offers registration only while active", () => {
    expect(deriveOnsiteActions({ ...base, registrationOpen: true }))
      .toEqual({ live: true, primary: "join" });
  });

  it("never shows vote or registration on a closed activity", () => {
    expect(deriveOnsiteActions({
      ...base,
      siteStatus: "closed",
      voteOpen: true,
      registrationOpen: true,
      hasResults: true,
    })).toEqual({ live: false, primary: "results" });
  });

  it("does not claim live without a current entry", () => {
    expect(deriveOnsiteActions({ ...base, hasCurrent: false, voteOpen: true }))
      .toEqual({ live: false, primary: "vote" });
  });

  it("lets the fresher current status close both the live view and the vote", () => {
    expect(deriveOnsiteActions({
      ...base,
      currentStatus: "closed",
      voteOpen: true,
      registrationOpen: true,
    })).toEqual({ live: false, primary: null });
  });
});

describe("matchCurrentProgramOrder", () => {
  const entries = [
    { order: 1, name: "林晓", song: "《后来》" },
    { order: 2, name: "周然", song: "《起风了》" },
  ];

  it("matches by order first", () => {
    expect(matchCurrentProgramOrder(entries, { order: 2, title: "别的名字", slotLabel: "别的歌" })).toBe(2);
  });

  it("falls back to name and song after a schedule re-release", () => {
    expect(matchCurrentProgramOrder(
      [{ order: 9, name: "周然", song: "《起风了》" }],
      { order: 2, title: "周然", slotLabel: "《起风了》" },
    )).toBe(9);
  });

  it("returns null instead of guessing", () => {
    expect(matchCurrentProgramOrder(entries, { order: 7, title: "无", slotLabel: "" })).toBeNull();
    expect(matchCurrentProgramOrder(entries, null)).toBeNull();
  });
});

describe("displayCandidateName", () => {
  it("prefers the resolved name", () => {
    expect(displayCandidateName({ candidateId: "alice", candidateName: "林晓" }, 1)).toBe("林晓");
  });

  it("keeps readable organizer text", () => {
    expect(displayCandidateName({ candidateId: "alice" }, 2)).toBe("alice");
  });

  it("never prints an opaque internal id", () => {
    expect(displayCandidateName({ candidateId: "acct_0123456789abcdef01234567" }, 3)).toBe("候选 3");
    expect(displayCandidateName({ candidateId: "550e8400-e29b-41d4-a716-446655440000" }, 4)).toBe("候选 4");
  });
});

describe("looksOpaqueId", () => {
  it("recognizes prefixed hashes and UUIDs", () => {
    expect(looksOpaqueId("part_0123456789abcdef01234567")).toBe(true);
    expect(looksOpaqueId("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
    expect(looksOpaqueId("alice")).toBe(false);
    expect(looksOpaqueId("张三")).toBe(false);
  });
});

describe("formatFreshness", () => {
  it("describes relative freshness without the client clock", () => {
    expect(formatFreshness(undefined, 0)).toBe("");
    expect(formatFreshness(1_000, 5_000)).toBe("刚刚更新");
    expect(formatFreshness(1_000, 31_000)).toBe("30 秒前更新");
    expect(formatFreshness(0, 125_000)).toBe("2 分钟前更新");
  });
});
