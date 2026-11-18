import { describe, expect, it } from "vitest";

import type { PublicEventSite } from "../src/public-event-service.js";
import { renderWechatArticle } from "../src/wechat-article-service.js";

const site: PublicEventSite = {
  activity: {
    publicCode: "SPRING-1",
    title: "春季十佳",
    status: "closed",
    registrationEnabled: true,
    registrationOpen: false,
  },
  profile: {
    tagline: "唱响春天",
    description: "院十佳歌手决赛",
    venue: "大礼堂",
    startsAt: "2026-11-18T19:00:00.000Z",
    endsAt: null,
    organizer: "文艺部",
    contact: "",
    announcement: "请提前入场",
    announcements: [],
    faq: [],
    links: [],
  },
  participants: null,
  schedule: {
    entries: [{ order: 1, slotLabel: "第 1 个", title: "开场", note: "", startsAt: null }],
  },
  program: null,
  results: {
    activityTitle: "春季十佳",
    results: [{
      stageKey: "final",
      publicTitle: "决赛结果",
      releasedAt: "2026-11-18T12:00:00.000Z",
      decisions: [{ rank: 1, contestantName: "<script>alert(1)</script>", score: "98.20" }],
      awards: [{ award: "冠军", contestantName: "林晓" }],
    }],
  },
};

describe("WeChat article", () => {
  it("renders inline HTML from the confirmed result and schedule", () => {
    const html = renderWechatArticle(
      { activityTitle: "春季十佳", publicCode: "SPRING-1", site },
      "https://artflow.example/e/SPRING-1",
    );
    expect(html).toContain("春季十佳");
    expect(html).toContain("决赛结果");
    expect(html).toContain("98.20");
    expect(html).toContain("第 1 个");
    expect(html).toContain("https://artflow.example/e/SPRING-1");
    expect(html).toContain("冠军：林晓");
  });

  it("escapes user-controlled names", () => {
    const html = renderWechatArticle(
      { activityTitle: "春季十佳", publicCode: "SPRING-1", site },
      "https://artflow.example/e/SPRING-1",
    );
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });
});
