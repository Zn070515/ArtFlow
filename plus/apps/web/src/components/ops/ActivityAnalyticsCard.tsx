import type { ActivityAnalyticsResponse } from "../../api/analytics.js";
import { AGGREGATE_STATUS_LABELS, label } from "../format/labels.js";
import { Card } from "../ui/Card.js";
import { describeRisk } from "./riskCatalog.js";

function statusSummary(values: Readonly<Record<string, number>>): string {
  const entries = Object.entries(values);
  return entries.length === 0
    ? "暂无记录"
    : entries.map(([status, count]) => `${label(AGGREGATE_STATUS_LABELS, status)} ${count}`).join(" · ");
}

export function ActivityAnalyticsCard({
  analytics,
}: {
  readonly analytics: ActivityAnalyticsResponse;
}) {
  return (
    <Card className="activity-analytics-card">
      <div className="activity-analytics-header">
        <div>
          <h2 className="ui-card__title">准备度与活动统计</h2>
        </div>
        <span className="analytics-readonly">只读汇总</span>
      </div>
      <div className="analytics-stat-grid">
        <div className="analytics-stat"><span>报名总数</span><strong>{analytics.registration.total}</strong><small>{statusSummary(analytics.registration.byStatus)}</small></div>
        <div className="analytics-stat"><span>必交材料待处理</span><strong>{analytics.materialChecks.requiredNotApproved}</strong><small>{statusSummary(analytics.materialChecks.byStatus)}</small></div>
        <div className="analytics-stat"><span>有效票数</span><strong>{analytics.voting.validBallots}</strong><small>{analytics.voting.sessions.total} 个投票场次</small></div>
        <div className="analytics-stat"><span>锁定回合</span><strong>{analytics.competition.rounds.locked}/{analytics.competition.rounds.total}</strong><small>{statusSummary(analytics.competition.rounds.byState)}</small></div>
        <div className="analytics-stat"><span>当前赛果发布</span><strong>{analytics.publishing.resultReleases.byStatus.active ?? 0}</strong><small>{statusSummary(analytics.publishing.resultReleases.byStatus)}</small></div>
        <div className="analytics-stat"><span>当前归档包</span><strong>{analytics.archive.currentPackages}</strong><small>历史版本 {analytics.archive.totalPackages}</small></div>
      </div>
      <div className="analytics-attention">
        <h3>运营注意项</h3>
        {(() => {
          const riskActivity = {
            ...analytics.activity,
            publicCode: "",
          };
          const items = analytics.attention
            .map((item) => describeRisk(item.code, riskActivity, item.count))
            .filter((item): item is NonNullable<typeof item> => item !== null);
          if (items.length === 0) {
            return <p className="analytics-clear">当前没有由聚合事实生成的注意项。</p>;
          }
          return (
            <ul>
              {items.map((item) => (
                <li key={item.code}>
                  <span>{item.title}</span>
                  {item.count === undefined ? null : <strong>{item.count}</strong>}
                  <p className="analytics-attention-reason">{item.reason}</p>
                </li>
              ))}
            </ul>
          );
        })()}
      </div>
    </Card>
  );
}
