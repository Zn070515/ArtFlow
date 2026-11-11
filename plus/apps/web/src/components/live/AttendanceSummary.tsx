import { useQuery } from "@tanstack/react-query";

import { fetchAttendance } from "../../api/attendance.js";
import { attendancePartitionForSession } from "../attendancePartition.js";

export function AttendanceSummary({
  activityId,
  sessionMode,
}: {
  readonly activityId: string;
  readonly sessionMode: "test" | "rehearsal" | "formal" | null | undefined;
}) {
  const partition = attendancePartitionForSession(sessionMode, "评分会话");
  const query = useQuery({
    queryKey: ["live-attendance", activityId, partition.mode],
    queryFn: () => fetchAttendance(activityId, { mode: partition.mode }),
    retry: false,
  });
  if (query.isPending) return <p className="auth-loading">正在加载签到…</p>;
  if (query.error !== null && query.error !== undefined) {
    return <p className="form-error" role="alert">签到数据暂时不可用。</p>;
  }
  return (
    <section className="ops-card" data-testid="live-attendance-summary">
      <p className="eyebrow">ATTENDANCE · 到场</p>
      {partition.disclosure === null ? null : (
        <p className="state-copy" data-testid="attendance-mode-disclosure">{partition.disclosure}</p>
      )}
      <ul>
        {query.data.summary.map((item) => (
          <li key={item.subjectType}>
            {{ participant: "参赛者", ticket: "票据", staff: "工作人员" }[item.subjectType]}
            ：应到 {item.expected} · 已到 {item.present} · 已撤销 {item.undone}
          </li>
        ))}
      </ul>
    </section>
  );
}
