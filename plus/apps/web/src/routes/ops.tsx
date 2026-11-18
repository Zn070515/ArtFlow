import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { fetchOperationsRisks, fetchOpsActivities } from "../api/ops.js";
import { RequireSession } from "../auth/RequireSession.js";
import {
  hasAnalyticsAccess,
  hasLiveAccess,
  hasOpsAccess,
  useSession,
} from "../auth/SessionProvider.js";
import { ConsolePagination } from "../components/console/ConsolePagination.js";
import {
  ACTIVITY_STATUS_LABELS,
  label,
} from "../components/format/labels.js";
import {
  deriveRiskRow,
  deriveRiskSummary,
  type RiskItem,
  type RiskRow,
  type RiskRowStatus,
} from "../components/ops/riskCatalog.js";
import { Badge, type BadgeTone } from "../components/ui/Badge.js";
import { Button } from "../components/ui/Button.js";
import { Card } from "../components/ui/Card.js";
import { ErrorState } from "../components/ui/ErrorState.js";
import { EmptyState } from "../components/ui/EmptyState.js";
import { Input } from "../components/ui/Input.js";
import { Select } from "../components/ui/Select.js";
import { Table } from "../components/ui/Table.js";
import { Toolbar } from "../components/ui/Toolbar.js";

const PAGE_SIZE = 25;

const RISK_STATUS_LABELS: Readonly<Record<RiskRowStatus, string>> = {
  blocked: "有阻塞",
  attention: "需关注",
  preparing: "准备中",
  ready: "就绪",
  closed: "已结束",
};

const RISK_STATUS_TONES: Readonly<Record<RiskRowStatus, BadgeTone>> = {
  blocked: "danger",
  attention: "warning",
  preparing: "neutral",
  ready: "success",
  closed: "neutral",
};

const RISK_RANK: Readonly<Record<RiskRowStatus, number>> = {
  blocked: 0,
  attention: 1,
  preparing: 2,
  ready: 3,
  closed: 4,
};

export function OpsPage() {
  return (
    <RequireSession>
      <OpsContent />
    </RequireSession>
  );
}

function OpsContent() {
  const { session } = useSession();
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [onlyRisk, setOnlyRisk] = useState(false);
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [searchTerm, statusFilter, onlyRisk]);
  const allowed = hasOpsAccess(session);
  const canUseRisk = hasAnalyticsAccess(session);
  const query = useQuery({
    queryKey: ["ops-activities"],
    queryFn: fetchOpsActivities,
    enabled: allowed,
    retry: false,
  });
  const riskQuery = useQuery({
    queryKey: ["ops-risks"],
    queryFn: fetchOperationsRisks,
    enabled: allowed && canUseRisk,
    retry: false,
  });

  if (!allowed) {
    return (
      <EmptyState
        title="没有运营权限"
        description="当前账号不能访问 Ops。"
      />
    );
  }
  if (query.isPending) return <p className="auth-loading">正在加载活动…</p>;
  if (query.error !== null) {
    return (
      <ErrorState
        description="活动列表暂时无法加载。"
        onRetry={() => { void query.refetch(); }}
      />
    );
  }

  const riskRows = riskQuery.data?.activities.map((row) =>
    deriveRiskRow(row.activity, row.attention),
  ) ?? [];
  const riskById = new Map(riskRows.map((row) => [row.activity.id, row]));
  const summary = deriveRiskSummary(riskRows);
  // A missing row means "no attention" only when the risk read actually
  // succeeded. On 403/500/pending the risk cell must say unknown; otherwise
  // every activity looks risk-free and the only-risk filter empties the list.
  const riskReady = canUseRisk && riskQuery.data !== undefined && riskQuery.error === null;
  const normalizedSearch = searchTerm.trim().toLocaleLowerCase();
  const statuses = [...new Set(query.data.map((activity) => activity.status))].sort();
  const filteredActivities = query.data
    .filter((activity) => {
      const matchesSearch = normalizedSearch.length === 0 ||
        `${activity.title} ${activity.publicCode}`.toLocaleLowerCase().includes(normalizedSearch);
      const matchesStatus = statusFilter.length === 0 || activity.status === statusFilter;
      const risk = riskById.get(activity.id);
      const matchesRisk = !onlyRisk || !riskReady || (risk?.items.length ?? 0) > 0;
      return matchesSearch && matchesStatus && matchesRisk;
    })
    .sort((left, right) => {
      const leftRisk = riskById.get(left.id);
      const rightRisk = riskById.get(right.id);
      const leftRank = leftRisk === undefined ? 5 : RISK_RANK[leftRisk.status];
      const rightRank = rightRisk === undefined ? 5 : RISK_RANK[rightRisk.status];
      return leftRank - rightRank || left.title.localeCompare(right.title);
    });
  const totalPages = Math.max(1, Math.ceil(filteredActivities.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const paginatedActivities = filteredActivities.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  function actionLink(row: RiskRow, item: RiskItem) {
    const activityId = row.activity.id;
    if (item.target.kind === "anchor") {
      return (
        <Link
          className="table-link"
          to="/ops/$activityId"
          params={{ activityId }}
          hash={item.target.id}
        >
          {item.actionLabel}
        </Link>
      );
    }
    if (item.target.kind === "public-results") {
      return (
        <Link
          className="table-link"
          to="/results/$publicCode"
          params={{ publicCode: row.activity.publicCode }}
        >
          {item.actionLabel}
        </Link>
      );
    }
    if (item.target.kind === "live") {
      return hasLiveAccess(session) ? (
        <Link className="table-link" to="/live/$activityId" params={{ activityId }}>
          {item.actionLabel}
        </Link>
      ) : (
        <Link className="table-link" to="/ops/$activityId" params={{ activityId }}>
          查看详情
        </Link>
      );
    }
    return null;
  }

  return (
    <section className="ops-page">
      <header className="ops-header">
        <h1 className="ui-page-title">运营风险</h1>
        <p className="ui-page-meta">{query.data.length} 个活动 · {filteredActivities.length} 个匹配</p>
      </header>
      <Card className="risk-summary" aria-labelledby="risk-summary-title">
        <div className="risk-summary__head">
          <h2 className="ui-card__title" id="risk-summary-title">风险总览</h2>
          {canUseRisk && riskQuery.data !== undefined ? (
            <span className="ui-card__description">{riskRows.length} 个未归档活动</span>
          ) : null}
        </div>
        {!canUseRisk ? (
          <p className="ui-card__description">
            风险看板需要分析权限；活动列表仍可使用。
          </p>
        ) : riskQuery.isPending ? (
          <p className="auth-loading">正在加载风险…</p>
        ) : riskQuery.error !== null ? (
          <>
            <p className="form-error" role="alert">风险看板暂时无法加载。</p>
            <Button variant="secondary" onClick={() => { void riskQuery.refetch(); }}>重试</Button>
          </>
        ) : (
          <div className="risk-summary__stats">
            {(["blocked", "attention", "preparing", "ready", "closed"] as const).map((status) => (
              <span key={status} className={`risk-stat risk-stat--${status}`}>
                {RISK_STATUS_LABELS[status]} <strong>{summary[status]}</strong>
              </span>
            ))}
          </div>
        )}
      </Card>
      {query.data.length === 0 ? (
        <EmptyState title="还没有活动" description="创建第一个活动后从这里开始。" />
      ) : (
        <>
          <Toolbar label="活动筛选">
            <Input
              type="search"
              label="搜索活动"
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
              placeholder="搜索名称或公开码"
            />
            <Select
              label="按状态筛选"
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
            >
              <option value="">全部状态</option>
              {statuses.map((status) => <option key={status} value={status}>{label(ACTIVITY_STATUS_LABELS, status)}</option>)}
            </Select>
            <label className="risk-filter">
              <input
                type="checkbox"
                checked={onlyRisk}
                disabled={!riskReady}
                onChange={(event) => setOnlyRisk(event.target.checked)}
              />
              只看有风险
            </label>
          </Toolbar>
          {filteredActivities.length === 0 ? (
            <EmptyState title="没有匹配的活动" description="调整搜索词、状态或风险筛选。" />
          ) : (
            <Table caption="活动列表">
              <thead>
                <tr>
                  <th scope="col">活动</th>
                  <th scope="col">公开码</th>
                  <th scope="col">状态</th>
                  <th scope="col">风险</th>
                  <th scope="col">风险项</th>
                  <th scope="col">操作</th>
                </tr>
              </thead>
              <tbody>
                {paginatedActivities.map((activity) => {
                  const risk = riskById.get(activity.id);
                  return (
                    <tr key={activity.id}>
                      <td data-label="活动">
                        <Link
                          to="/ops/$activityId"
                          params={{ activityId: activity.id }}
                          className="table-link"
                        >
                          {activity.title}
                        </Link>
                      </td>
                      <td data-label="公开码">{activity.publicCode}</td>
                      <td data-label="状态">{label(ACTIVITY_STATUS_LABELS, activity.status)}</td>
                      <td data-label="风险">
                        {!riskReady ? (
                          <span className="risk-none">
                            {riskQuery.isPending ? "正在加载风险…" : "风险未知"}
                          </span>
                        ) : risk === undefined ? (
                          <span className="risk-none">—</span>
                        ) : (
                          <div className="risk-cell">
                            <Badge tone={RISK_STATUS_TONES[risk.status]}>
                              {RISK_STATUS_LABELS[risk.status]}
                            </Badge>
                            <span className="risk-counts">
                              {risk.critical > 0 ? `阻塞 ${risk.critical}` : ""}
                              {risk.critical > 0 && risk.warning > 0 ? " · " : ""}
                              {risk.warning > 0 ? `关注 ${risk.warning}` : ""}
                            </span>
                          </div>
                        )}
                      </td>
                      <td data-label="风险项">
                        {risk === undefined || risk.items.length === 0 ? (
                          <span className="risk-none">—</span>
                        ) : (
                          <>
                            <span className="risk-top">
                              {risk.items.slice(0, 2).map((item) => item.title).join(" · ")}
                              {risk.items.length > 2 ? ` 等 ${risk.items.length} 项` : ""}
                            </span>
                            <details className="risk-items">
                              <summary>查看原因</summary>
                              <ul>
                                {risk.items.map((item) => (
                                  <li key={item.code}>
                                    <Badge tone={item.severity === "critical" ? "danger" : "warning"}>
                                      {item.severity === "critical" ? "阻塞" : "关注"}
                                    </Badge>
                                    <span className="risk-item-title">
                                      {item.title}
                                      {item.count === undefined ? "" : ` · ${item.count}`}
                                    </span>
                                    <p className="risk-item-reason">{item.reason}</p>
                                    {actionLink(risk, item)}
                                  </li>
                                ))}
                              </ul>
                            </details>
                          </>
                        )}
                      </td>
                      <td data-label="操作">
                        <Link
                          className="table-link"
                          to="/ops/$activityId"
                          params={{ activityId: activity.id }}
                        >
                          打开 Ops
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          )}
          <ConsolePagination page={currentPage} totalPages={totalPages} onPageChange={setPage} />
        </>
      )}
    </section>
  );
}
