import type { ActivityAnalyticsResponse } from "../../api/analytics.js";

const ATTENTION_LABELS: Readonly<Record<string, string>> = {
  REGISTRATION_REVIEW_PENDING: "报名仍有待审核项",
  REQUIRED_MATERIALS_PENDING: "必交材料尚未全部通过",
  ROSTER_NOT_FINAL: "最终名单尚未定稿",
  FORMAL_VOTE_OPEN: "正式投票仍处于开放状态",
  COMPETITION_ROUND_NOT_LOCKED: "仍有比赛回合未锁定",
  RESULT_STALE: "已确认赛果的来源发生变化",
  RESULT_RELEASE_PENDING: "仍有赛果需要确认或发布",
  ARCHIVE_MISSING: "活动已关闭但尚无当前归档包",
};

function attentionLabel(code: string): string {
  return ATTENTION_LABELS[code] ?? code;
}

function statusSummary(values: Readonly<Record<string, number>>): string {
  const entries = Object.entries(values);
  return entries.length === 0 ? "暂无记录" : entries.map(([status, count]) => `${status} ${count}`).join(" · ");
}

export function ActivityAnalyticsCard({
  analytics,
}: {
  readonly analytics: ActivityAnalyticsResponse;
}) {
  return (
    <section className="ops-card activity-analytics-card">
      <div className="activity-analytics-header">
        <div>
          <p className="eyebrow">ANALYTICS · 运营分析</p>
          <h2>准备度与活动统计</h2>
        </div>
        <span className="analytics-readonly">只读投影</span>
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
        {analytics.attention.length === 0 ? (
          <p className="analytics-clear">当前没有由聚合事实生成的注意项。</p>
        ) : (
          <ul>
            {analytics.attention.map((item) => (
              <li key={item.code}>
                <span>{attentionLabel(item.code)}</span>
                {item.count === undefined ? null : <strong>{item.count}</strong>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
