import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchReadiness, fetchTasks, mutateTask } from "./tasks.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("tasks API client", () => {
  it("encodes activity IDs for task and readiness reads", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);

    await fetchTasks("activity/one");
    await fetchReadiness("activity/one");

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/activities/activity%2Fone/tasks");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/activities/activity%2Fone/readiness");
  });

  it("sends the current revision and an idempotency key for mutations", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);

    await mutateTask("activity-1", "task/1", "complete", {
      expectedRevision: 4,
      reason: "已完成复核",
    });

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/activities/activity-1/tasks/task%2F1/complete");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers as HeadersInit).get("idempotency-key")).toEqual(expect.any(String));
    expect(JSON.parse(String(init.body))).toEqual({ expectedRevision: 4, reason: "已完成复核" });
  });
});
