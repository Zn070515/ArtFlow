import { afterEach, describe, expect, it, vi } from "vitest";

import {
  closeScoreCorrection,
  decideTie,
  editScoreFact,
  fetchRoundScores,
  finalizeAdvancement,
  openScoreCorrection,
  recalculateAfterCorrection,
  resetRehearsal,
} from "./live.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(payload: unknown = {}): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => payload,
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("live client", () => {
  it("posts the rehearsal reset with the judging scope and mode", async () => {
    const fetchMock = stubFetch({ round: { state: "prepared" } });

    await resetRehearsal("act-1", "round-1", "rehearsal");

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/activities/act-1/competition/rounds/round-1/reset-rehearsal");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers as HeadersInit).get("idempotency-key")).toEqual(expect.any(String));
    expect(JSON.parse(String(init.body))).toEqual({ scope: "judging", mode: "rehearsal" });
  });

  it("reads the round scores with the judging scope", async () => {
    const fetchMock = stubFetch();

    await fetchRoundScores("act-1", "final");

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/activities/act-1/competition/rounds/final/scores?scope=judging");
    expect(init.method ?? "GET").toBe("GET");
  });

  it("opens a score correction under the score fact", async () => {
    const fetchMock = stubFetch();

    await openScoreCorrection("act-1", "final", {
      performanceId: "performance-1",
      scoreFactId: "score-1",
      panelSnapshotId: "panel-1",
      reason: "record error",
    });

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe(
      "/api/activities/act-1/competition/rounds/final/scores/score-1/corrections",
    );
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers as HeadersInit).get("idempotency-key")).toEqual(expect.any(String));
    expect(JSON.parse(String(init.body))).toEqual({
      scope: "judging",
      performanceId: "performance-1",
      panelSnapshotId: "panel-1",
      reason: "record error",
    });
  });

  it("edits a score fact with PATCH", async () => {
    const fetchMock = stubFetch();

    await editScoreFact("act-1", "final", {
      scoreFactId: "score-1",
      performanceId: "performance-1",
      panelSnapshotId: "panel-1",
      seatId: "seat-1",
      contextVersion: 1,
      expectedVersion: 1,
      criteria: { total: 95 },
      reason: "看错分",
      correctionId: "correction-1",
    });

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/activities/act-1/competition/rounds/final/scores/score-1");
    expect(init.method).toBe("PATCH");
    expect(new Headers(init.headers as HeadersInit).get("idempotency-key")).toEqual(expect.any(String));
    expect(JSON.parse(String(init.body))).toEqual({
      scope: "judging",
      performanceId: "performance-1",
      panelSnapshotId: "panel-1",
      seatId: "seat-1",
      contextVersion: 1,
      expectedVersion: 1,
      criteria: { total: 95 },
      reason: "看错分",
      correctionId: "correction-1",
    });
  });

  it("closes a score correction", async () => {
    const fetchMock = stubFetch();

    await closeScoreCorrection("act-1", "final", {
      scoreFactId: "score-1",
      correctionId: "correction-1",
      panelSnapshotId: "panel-1",
      performanceId: "performance-1",
    });

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe(
      "/api/activities/act-1/competition/rounds/final/scores/score-1/corrections/correction-1/close",
    );
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers as HeadersInit).get("idempotency-key")).toEqual(expect.any(String));
    expect(JSON.parse(String(init.body))).toEqual({
      scope: "judging",
      panelSnapshotId: "panel-1",
      performanceId: "performance-1",
    });
  });

  it("recalculates after a correction", async () => {
    const fetchMock = stubFetch();

    await recalculateAfterCorrection("act-1", "final", {
      scoreFactId: "score-1",
      correctionId: "correction-1",
      panelSnapshotId: "panel-1",
      performanceId: "performance-1",
    });

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe(
      "/api/activities/act-1/competition/rounds/final/scores/score-1/corrections/correction-1/recalculate",
    );
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers as HeadersInit).get("idempotency-key")).toEqual(expect.any(String));
    expect(JSON.parse(String(init.body))).toEqual({
      scope: "judging",
      panelSnapshotId: "panel-1",
      performanceId: "performance-1",
    });
  });

  it("decides a tie with the ranking snapshot", async () => {
    const fetchMock = stubFetch();

    await decideTie("act-1", "final", {
      tieId: "tie-1",
      rankingSnapshotId: "ranking-1",
      inputFingerprint: "fp",
      contestants: ["a", "b"],
      order: ["b", "a"],
      reason: "现场裁决",
    });

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/activities/act-1/competition/rounds/final/ties/tie-1/decide");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers as HeadersInit).get("idempotency-key")).toEqual(expect.any(String));
    expect(JSON.parse(String(init.body))).toEqual({
      scope: "judging",
      rankingSnapshotId: "ranking-1",
      inputFingerprint: "fp",
      contestants: ["a", "b"],
      order: ["b", "a"],
      reason: "现场裁决",
    });
  });

  it("finalizes advancement with the expected ranking revision", async () => {
    const fetchMock = stubFetch();

    await finalizeAdvancement("act-1", "final", 2);

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/activities/act-1/competition/rounds/final/advancement/finalize");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers as HeadersInit).get("idempotency-key")).toEqual(expect.any(String));
    expect(JSON.parse(String(init.body))).toEqual({
      scope: "judging",
      expectedRankingRevision: 2,
    });
  });
});
