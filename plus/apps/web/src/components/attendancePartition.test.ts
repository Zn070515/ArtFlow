import { describe, expect, it } from "vitest";

import { attendancePartitionForSession } from "./attendancePartition.js";

describe("attendancePartitionForSession", () => {
  it("reads the test partition only for a test session", () => {
    expect(attendancePartitionForSession("test", "评分会话")).toEqual({
      mode: "test",
      disclosure: null,
    });
  });

  it("reads formal for a formal session without an extra warning", () => {
    expect(attendancePartitionForSession("formal", "评分会话")).toEqual({
      mode: "formal",
      disclosure: null,
    });
  });

  it("keeps a rehearsal session from silently reading formal attendance", () => {
    expect(attendancePartitionForSession("rehearsal", "评分会话")).toEqual({
      mode: "formal",
      disclosure: "签到没有 rehearsal 分区，当前数字是 formal。",
    });
  });

  it("labels the formal partition when no session is running", () => {
    expect(attendancePartitionForSession(null, "签到会话")).toEqual({
      mode: "formal",
      disclosure: "当前没有签到会话，下列数字是 formal 分区。",
    });
    expect(attendancePartitionForSession(undefined, "评分会话").disclosure).toBe(
      "当前没有评分会话，下列数字是 formal 分区。",
    );
  });
});
