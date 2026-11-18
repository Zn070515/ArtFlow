import type { LiveState } from "../../api/live.js";
import { EXECUTION_MODE_LABELS, ROUND_STATE_LABELS, label, participantLabel } from "../format/labels.js";
import { Badge } from "../ui/Badge.js";
import { deriveLiveCommand, type LiveCommandView } from "./liveCommandModel.js";

interface PrimaryAction {
  readonly href: string;
  readonly label: string;
}

function statusText(state: LiveState, view: LiveCommandView): string {
  if (view.phase === "inactive") {
    if (state.activity.status === "archived") return "活动已归档";
    if (state.activity.status === "closed") return "活动已结束";
    return "活动未激活";
  }
  if (view.session === "none") return "未启动评分会话";
  return `运行中 · ${label(EXECUTION_MODE_LABELS, view.mode)}`;
}

function statusTone(view: LiveCommandView): "success" | "warning" | "neutral" | "danger" {
  if (view.phase === "inactive") return "neutral";
  if (view.phase === "round_hold") return "danger";
  if (view.phase === "scoring") return "warning";
  return "success";
}

function primaryAction(view: LiveCommandView, permissions: {
  readonly canManageSession: boolean;
  readonly canManageSetup: boolean;
  readonly canManageCompetition: boolean;
  readonly canManageResults: boolean;
}): PrimaryAction | null {
  if (view.phase === "inactive") return null;
  if (view.phase === "completed") {
    return permissions.canManageResults ? { href: "#live-result", label: "查看/发布赛果" } : null;
  }
  if (view.phase === "no_session") {
    return permissions.canManageSession ? { href: "#live-session", label: "去启动会话" } : null;
  }
  if (view.phase === "round_hold") {
    return permissions.canManageCompetition && view.focusRoundKey !== null
      ? { href: `#live-tie-${view.focusRoundKey}`, label: "去处理 HOLD" }
      : null;
  }
  if (view.phase === "round_resolved") {
    const next = view.next;
    if (next === null) {
      return permissions.canManageResults ? { href: "#live-result", label: "查看/发布赛果" } : null;
    }
    return permissions.canManageSetup ? { href: `#round-${next.roundKey}`, label: "去下一轮" } : null;
  }
  const roundKey = view.focusRoundKey;
  if (roundKey === null) return null;
  if (view.phase === "awaiting_start") {
    return permissions.canManageSetup ? { href: `#round-${roundKey}`, label: "去开始/准备" } : null;
  }
  if (view.phase === "scoring") {
    return { href: `#round-${roundKey}`, label: "去评分" };
  }
  if (view.phase === "round_scored") {
    return permissions.canManageSetup ? { href: `#round-${roundKey}`, label: "去锁定回合" } : null;
  }
  return null;
}

function phaseDetail(view: LiveCommandView): string {
  if (view.phase === "inactive") return "活动已结束或归档，现场命令不可执行。";
  if (view.phase === "no_session") return "还没有运行中的评审会话。";
  if (view.phase === "awaiting_start") return "等待开始下一位表演。";
  if (view.phase === "scoring") return view.readyToScore ? "评分席位已就绪，可以开始评分。" : "等待评委席位或面板就绪。";
  if (view.phase === "round_scored") return "本轮表演已全部评分，等待锁定回合。";
  if (view.phase === "round_hold") return "排名存在并列或尚未解析，下一轮被阻塞。";
  if (view.phase === "round_resolved") {
    return view.next === null ? "本轮排名已就绪，等待结果发布。" : "本轮已解析，可以进入下一轮。";
  }
  return "全部轮次已完成。";
}

export function LiveCommandBar({
  state,
  canManageSession,
  canManageSetup,
  canManageCompetition,
  canManageResults,
}: {
  readonly state: LiveState;
  readonly canManageSession: boolean;
  readonly canManageSetup: boolean;
  readonly canManageCompetition: boolean;
  readonly canManageResults: boolean;
}) {
  const view = deriveLiveCommand(state);
  const action = primaryAction(view, {
    canManageSession,
    canManageSetup,
    canManageCompetition,
    canManageResults,
  });
  const currentName = view.current === null
    ? null
    : participantLabel(state.participantNames, view.current.participantId);
  const focusRound = state.rounds.find((round) => round.config.key === view.focusRoundKey);

  return (
    <section className="live-command" data-testid="live-command" aria-labelledby="live-command-title">
      <div className="live-command__head">
        <h2 className="ui-card__title" id="live-command-title">现场指挥</h2>
        <div className="live-command__badges">
          <Badge tone={statusTone(view)}>{statusText(state, view)}</Badge>
          {view.phase === "round_hold" ? <Badge tone="danger">HOLD</Badge> : null}
        </div>
      </div>
      <div className="live-command__grid">
        <div className="live-command__block live-command__current" aria-live="polite">
          <span className="live-command__label">当前</span>
          {view.current === null ? (
            <strong>{phaseDetail(view)}</strong>
          ) : (
            <>
              <strong>
                第 {(view.focusRoundIndex ?? 0) + 1} 轮 · 第 {view.current.sequence} 位 · {currentName}
              </strong>
              <span className="live-command__progress">
                <progress
                  aria-label="评分进度"
                  value={view.current.scoreCount}
                  max={view.current.expectedJudges}
                />
                评分 {view.current.scoreCount}/{view.current.expectedJudges}
              </span>
              <span className="live-command__detail">
                席位 {view.seats.assigned}/{view.seats.expected}（最低 {view.seats.minimum}）
                {view.readyToScore ? " · 可评分" : ""}
              </span>
            </>
          )}
        </div>
        <div className="live-command__block">
          <span className="live-command__label">下一</span>
          <strong>{view.next?.label ?? "—"}</strong>
          <span className="live-command__detail">{focusRound?.panel?.state ?? ""}</span>
        </div>
        <div className="live-command__block">
          <span className="live-command__label">关联</span>
          {canManageSession ? (
            <a className="ui-button ui-button--secondary ui-button--sm" href="#live-session">评委入口/会话</a>
          ) : null}
          {canManageCompetition && view.focusRoundKey !== null ? (
            <>
              <a className="ui-button ui-button--secondary ui-button--sm" href={`#live-tie-${view.focusRoundKey}`}>平局推进</a>
              <a className="ui-button ui-button--secondary ui-button--sm" href={`#live-exception-${view.focusRoundKey}`}>异常与修正</a>
            </>
          ) : null}
        </div>
      </div>
      <nav className="live-command__rounds" aria-label="轮次导航">
        {view.rounds.map((round) => (
          <a
            key={round.key}
            className={`live-command__round${round.index === view.focusRoundIndex ? " is-focus" : ""}${round.hold ? " is-hold" : ""}`}
            href={`#round-${round.key}`}
          >
            第 {round.index + 1} 轮 · {round.state === "none" ? "未准备" : label(ROUND_STATE_LABELS, round.state)}
            {round.totalPerformances > 0 ? ` · ${round.lockedPerformances}/${round.totalPerformances}` : ""}
            {round.hold ? " · HOLD" : ""}
          </a>
        ))}
      </nav>
      <div className="live-command__footer">
        <span className="live-command__detail">{phaseDetail(view)}</span>
        {action === null ? null : (
          <a className="ui-button ui-button--primary ui-button--sm" href={action.href}>
            {action.label}
          </a>
        )}
      </div>
    </section>
  );
}
