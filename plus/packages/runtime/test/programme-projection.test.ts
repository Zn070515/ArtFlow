import { describe, expect, it } from "vitest";

import { projectProgramme } from "../src/programme-projection.js";

const show = {
  activityTitle: "2026 毕业晚会",
  publicCode: "GRAD",
  activityStatus: "active" as const,
  rosterStatus: "final" as const,
};

describe("projectProgramme", () => {
  it("orders approved programmes and keeps draft titles unpublished", () => {
    const published = projectProgramme({
      ...show,
      registrations: [
        { id: "b", status: "approved", answers: { program: "合唱《毕业歌》", name: "音乐系", description: "全体起立" } },
        { id: "a", status: "approved", answers: { song: "开场致辞", name: "主持人" } },
        { id: "c", status: "submitted", answers: { program: "不能提前看到的节目", name: "候补" } },
        { id: "d", status: "rejected", answers: { program: "落选节目", name: "落选" } },
      ],
    });
    expect(published.published).toBe(true);
    expect(published.emptyReason).toBeNull();
    expect(published.items).toEqual([
      { order: 1, title: "开场致辞", performers: "主持人", notes: "" },
      { order: 2, title: "合唱《毕业歌》", performers: "音乐系", notes: "全体起立" },
    ]);

    const draft = projectProgramme({
      ...show,
      activityStatus: "draft",
      registrations: published.items.map((item, index) => ({
        id: String(index),
        status: "approved",
        answers: { program: item.title },
      })),
    });
    expect(draft.published).toBe(false);
    expect(draft.emptyReason).toBe("activity_not_active");
    expect(draft.items).toEqual([]);
  });

  it("stays empty until the roster is final, including when names already exist", () => {
    const unpublished = projectProgramme({
      ...show,
      rosterStatus: "unknown",
      registrations: [{ id: "a", status: "approved", answers: { program: "不能提前看到的节目" } }],
    });
    expect(unpublished).toMatchObject({
      published: false,
      emptyReason: "roster_not_final",
      items: [],
    });
  });

  it("publishes an explicit empty programme when the final roster has no approved acts", () => {
    expect(projectProgramme({ ...show, registrations: [] })).toMatchObject({
      published: true,
      emptyReason: "no_approved_programmes",
      items: [],
    });
  });
});
