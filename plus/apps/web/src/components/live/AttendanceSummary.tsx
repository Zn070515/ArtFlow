import { useQuery } from "@tanstack/react-query";

import { fetchAttendance } from "../../api/attendance.js";
import { Card } from "../ui/Card.js";

export function AttendanceSummary({
  activityId,
  mode,
  rehearsal,
}: {
  readonly activityId: string;
  readonly mode: "formal" | "test";
  readonly rehearsal: boolean;
}) {
  const query = useQuery({
    queryKey: ["live-attendance", activityId, mode],
    queryFn: () => fetchAttendance(activityId, { mode }),
    retry: false,
  });
  if (query.isPending) return <p className="auth-loading">正在加载签到…</p>;
  if (query.error !== null && query.error !== undefined) {
    return <p className="ui-field__error" role="alert">签到数据暂时不可用。</p>;
  }
  return (
    <Card data-testid="live-attendance-summary">
      <h2 className="ui-card__title">到场</h2>
      {rehearsal ? (
        <p className="ui-card__description">签到只有正式 / 测试分区；当前显示正式数据。</p>
      ) : null}
      <ul>
        {query.data.summary.map((item) => (
          <li key={item.subjectType}>
            {{ participant: "参赛者", ticket: "票据", staff: "工作人员" }[item.subjectType]}
            ：应到 {item.expected} · 已到 {item.present} · 已撤销 {item.undone}
          </li>
        ))}
      </ul>
    </Card>
  );
}
