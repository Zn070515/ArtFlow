import { describe, expect, it } from "vitest";

import type { StudioState } from "../../api/studio.js";
import { deriveReadiness } from "./studioReadiness.js";

function state(overrides: Partial<StudioState> = {}): StudioState {
  return {
    activity: {
      id: "act-1",
      publicCode: "AF-1",
      title: "春季赛",
      status: "active",
      revision: 2,
      enabledCapabilities: ["competition"],
      activeDefinitionVersion: 1,
    },
    draft: { revision: 2, package: {} },
    compiled: { draftRevision: 2, contentHash: "hash-a", capabilities: [] },
    releases: [{
      version: 1,
      contentHash: "hash-a",
      releasedAt: "2026-11-18T00:00:00.000Z",
      sourceDraftRevision: 2,
      declaredScopes: [],
      capabilityVersions: { competition: "1" },
      active: true,
    }],
    sessions: [],
    publicProfile: {
      activityId: "act-1",
      tagline: "校园歌手赛",
      description: "",
      venue: "礼堂",
      startsAt: null,
      endsAt: null,
      organizer: "学生会",
      contact: "",
      announcement: "",
      revision: 1,
      updatedBy: "ops-1",
      updatedAt: "2026-11-18T00:00:00.000Z",
    },
    ...overrides,
  };
}

function step(view: ReturnType<typeof deriveReadiness>, id: string) {
  return view.steps.find((candidate) => candidate.id === id);
}

describe("deriveReadiness", () => {
  it("is ready when the active release matches the compiled hash", () => {
    expect(deriveReadiness(state()).ready).toBe(true);
  });

  it("marks the release stale when the compiled hash differs", () => {
    const view = deriveReadiness(state({
      compiled: { draftRevision: 3, contentHash: "hash-b", capabilities: [] },
    }));
    expect(view.ready).toBe(false);
    expect(step(view, "release")?.status).toBe("stale");
  });

  it("does not treat a no-op recompile as stale", () => {
    const view = deriveReadiness(state({
      draft: { revision: 3, package: {} },
      compiled: { draftRevision: 3, contentHash: "hash-a", capabilities: [] },
    }));
    expect(view.ready).toBe(true);
    expect(step(view, "release")?.status).toBe("done");
  });

  it("blocks compile and release on archived activities", () => {
    const view = deriveReadiness(state({
      activity: { ...state().activity, status: "archived" },
      compiled: null,
    }));
    expect(view.terminal).toBe("archived");
    expect(view.ready).toBe(false);
    expect(step(view, "compile")?.status).toBe("blocked");
    expect(step(view, "release")?.href).toBeUndefined();
  });

  it("does not offer a release action on a closed activity", () => {
    const view = deriveReadiness(state({
      activity: { ...state().activity, status: "closed" },
      compiled: { draftRevision: 3, contentHash: "hash-b", capabilities: [] },
    }));
    expect(view.terminal).toBe("closed");
    expect(step(view, "release")?.status).toBe("stale");
    expect(step(view, "release")?.href).toBeUndefined();
  });

  it("keeps the public profile optional", () => {
    const view = deriveReadiness(state({
      publicProfile: { ...state().publicProfile, tagline: "", description: "" },
    }));
    expect(view.ready).toBe(true);
    expect(step(view, "profile")?.status).toBe("pending");
  });

  it("points the release step at the running session before the release panel", () => {
    const view = deriveReadiness(state({
      compiled: { draftRevision: 3, contentHash: "hash-b", capabilities: [] },
      sessions: [{
        id: "session-1",
        activityId: "act-1",
        definitionVersion: 1,
        contentHash: "hash-a",
        scope: "competition",
        mode: "formal",
        status: "running",
        revision: 0,
        openedAt: "2026-11-18T00:00:00.000Z",
      }],
    }));
    expect(step(view, "release")?.detail).toContain("先关闭运行中的会话");
    expect(step(view, "release")?.href).toBe("#session-panel");
  });
});
