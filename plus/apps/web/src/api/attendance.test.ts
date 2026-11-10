import { afterEach, describe, expect, it, vi } from "vitest";

import {
  addAttendanceStaff,
  checkInAttendance,
  createAttendancePoint,
  fetchAttendance,
  undoAttendance,
} from "./attendance.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("attendance API client", () => {
  it("encodes the activity and query for attendance reads", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);

    await fetchAttendance("activity/one", { point: "gate", subjectType: "participant", mode: "formal" });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/activities/activity%2Fone/attendance?point=gate&subjectType=participant&mode=formal",
    );
  });

  it("sends idempotency keys and the check-in union", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);

    await checkInAttendance("activity-1", {
      pointKey: "gate",
      subjectType: "ticket",
      credential: "T.abc",
    });
    await undoAttendance("activity-1", {
      pointKey: "gate",
      subjectType: "participant",
      subjectId: "registration-1",
    });

    const [checkinPath, checkinInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(checkinPath).toBe("/api/activities/activity-1/attendance/checkin");
    expect(checkinInit.method).toBe("POST");
    expect(new Headers(checkinInit.headers as HeadersInit).get("idempotency-key")).toEqual(expect.any(String));
    expect(JSON.parse(String(checkinInit.body))).toEqual({
      pointKey: "gate",
      subjectType: "ticket",
      credential: "T.abc",
    });

    const [undoPath] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(undoPath).toBe("/api/activities/activity-1/attendance/undo");
  });

  it("creates points and staff entries", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 201, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);

    await createAttendancePoint("activity-1", {
      key: "gate",
      name: "入口",
      subjectTypes: ["participant", "ticket", "staff"],
    });
    await addAttendanceStaff("activity-1", { displayName: "志愿者甲" });

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/activities/activity-1/attendance/points");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/activities/activity-1/attendance/staff");
  });
});
