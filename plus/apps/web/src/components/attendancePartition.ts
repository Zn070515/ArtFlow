export type AttendancePartitionMode = "formal" | "test";

export interface AttendancePartition {
  readonly mode: AttendancePartitionMode;
  /** Present when the numbers are not the session's own partition. */
  readonly disclosure: string | null;
}

/**
 * Attendance facts exist only in formal and test (ATT-03). A rehearsal
 * check-in is rejected (ATT-05), so a rehearsal session must not be read as
 * if it were formal without saying so.
 */
export function attendancePartitionForSession(
  sessionMode: "test" | "rehearsal" | "formal" | null | undefined,
  sessionName: string,
): AttendancePartition {
  if (sessionMode === "test") return { mode: "test", disclosure: null };
  if (sessionMode === "formal") return { mode: "formal", disclosure: null };
  if (sessionMode === "rehearsal") {
    return { mode: "formal", disclosure: "签到没有 rehearsal 分区，当前数字是 formal。" };
  }
  return { mode: "formal", disclosure: `当前没有${sessionName}，下列数字是 formal 分区。` };
}
