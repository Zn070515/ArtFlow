import { useQuery } from "@tanstack/react-query";

import { fetchActivityFeedback } from "../../api/feedback.js";
import { Card } from "../ui/Card.js";
import { EmptyState } from "../ui/EmptyState.js";

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function FeedbackCard({ activityId }: { readonly activityId: string }) {
  const query = useQuery({
    queryKey: ["activity-feedback", activityId],
    queryFn: () => fetchActivityFeedback(activityId),
    retry: false,
  });

  return (
    <Card id="feedback">
      <h2 className="ui-card__title">赛后反馈</h2>
      {query.isPending ? <p className="auth-loading">正在加载反馈…</p> : null}
      {query.error !== null ? (
        <p className="form-error" role="alert">反馈暂时无法加载。</p>
      ) : null}
      {query.data !== undefined ? (
        query.data.summary.count === 0 ? (
          <EmptyState
            title="还没有反馈"
            description="活动闭幕后，观众可以在公开活动页提交反馈。"
          />
        ) : (
          <>
            <p className="ui-card__description">
              共 {query.data.summary.count} 条 · 平均{" "}
              {query.data.summary.average === null ? "—" : query.data.summary.average.toFixed(1)} 分
            </p>
            <ul className="ops-feedback-list">
              {query.data.items.slice(0, 20).map((item) => (
                <li key={item.id}>
                  <div className="ops-feedback-list__head">
                    <span>{item.rating} 分</span>
                    <time>{formatTime(item.submittedAt)}</time>
                  </div>
                  {item.comment === "" ? null : <p>{item.comment}</p>}
                </li>
              ))}
            </ul>
          </>
        )
      ) : null}
    </Card>
  );
}
