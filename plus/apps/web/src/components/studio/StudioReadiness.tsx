import { Link } from "@tanstack/react-router";

import type { StudioState } from "../../api/studio.js";
import { Badge, type BadgeTone } from "../ui/Badge.js";
import { Button } from "../ui/Button.js";
import { Card } from "../ui/Card.js";
import { deriveReadiness, type ReadinessStatus } from "./readiness.js";

const TONES: Readonly<Record<ReadinessStatus, BadgeTone>> = {
  done: "success",
  current: "warning",
  pending: "neutral",
  stale: "danger",
  blocked: "neutral",
};

const LABELS: Readonly<Record<ReadinessStatus, string>> = {
  done: "已完成",
  current: "现在处理",
  pending: "未开始",
  stale: "需重新发布",
  blocked: "只读",
};

export function StudioReadiness({
  state,
  onActivate,
}: {
  readonly state: StudioState;
  readonly onActivate: () => void;
}) {
  const view = deriveReadiness(state);
  const activityId = state.activity.id;
  const actionStatuses: readonly ReadinessStatus[] = ["current", "pending", "stale"];

  return (
    <Card className="studio-readiness" aria-labelledby="studio-readiness-title">
      <div className="studio-readiness__head">
        <div>
          <h2 className="ui-card__title" id="studio-readiness-title">上线就绪度</h2>
          <p className="ui-card__description">
            {view.terminal === "archived"
              ? "活动已归档，配置只读。"
              : view.terminal === "closed"
                ? "活动已结束；不能重新发布。"
                : view.ready
                  ? "活动已就绪，可以去 Ops 准备报名、名单和现场。"
                  : `${view.completed}/${view.total} 步完成`}
          </p>
        </div>
        <Badge tone={view.ready ? "success" : view.terminal === null ? "warning" : "neutral"}>
          {view.ready ? "READY" : view.terminal === "archived" ? "ARCHIVED" : view.terminal === "closed" ? "CLOSED" : "SETUP"}
        </Badge>
      </div>
      <ol className="studio-readiness__steps">
        {view.steps.map((step, index) => (
          <li key={step.id} className={`studio-readiness__step is-${step.status}`}>
            <span className="studio-readiness__index" aria-hidden="true">{index + 1}</span>
            <div className="studio-readiness__body">
              <span className="studio-readiness__title">{step.title}</span>
              <span className="studio-readiness__detail">{step.detail}</span>
            </div>
            <Badge tone={TONES[step.status]}>{LABELS[step.status]}</Badge>
            {step.id === "activate" && state.activity.status === "draft" ? (
              <Button variant="secondary" size="sm" onClick={onActivate}>激活活动</Button>
            ) : null}
            {step.id === "profile" && view.terminal === null ? (
              <Link
                className="table-link"
                to="/studio/$activityId/public"
                params={{ activityId }}
              >
                编辑公开主页
              </Link>
            ) : null}
            {step.id === "ops" && view.ready ? (
              <Link className="table-link" to="/ops/$activityId" params={{ activityId }}>打开 Ops</Link>
            ) : null}
            {step.href === undefined || view.terminal !== null || !actionStatuses.includes(step.status) ? null : (
              <a className="table-link" href={step.href}>去处理</a>
            )}
          </li>
        ))}
      </ol>
    </Card>
  );
}
