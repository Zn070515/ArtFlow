import { useState } from "react";

import {
  activatePanel,
  advancePerformance,
  describeLiveError,
  lockPerformance,
  lockRound,
  openPerformance,
  prepareRound,
  reopenRoundForCorrection,
  resetRehearsal,
  resolveRound,
  type LiveRound,
  type LiveState,
} from "../../api/live.js";
import { Badge } from "../ui/Badge.js";
import { Button } from "../ui/Button.js";
import { Card } from "../ui/Card.js";
import { ConfirmDialog, ReasonDialog } from "../ui/Dialog.js";
import { Input } from "../ui/Input.js";
import { Select } from "../ui/Select.js";
import { Table } from "../ui/Table.js";
import { liveDisplayRanks } from "./ranking.js";

interface JudgeDraft {
  readonly judgeId: string;
  readonly seatKey: string;
}

export function LiveRoundPanel({
  state,
  live,
  sessionMode,
  onChanged,
  canPrepare = true,
  canManageSetup = true,
  canResolve = true,
}: {
  readonly state: LiveState;
  readonly live: LiveRound;
  readonly sessionMode?: "test" | "rehearsal" | "formal";
  readonly onChanged: () => void;
  /** Preparing a round also accepts competition.round.prepare. */
  readonly canPrepare?: boolean;
  /** Panel, performance, lock, reopen and reset commands require competition.manage. */
  readonly canManageSetup?: boolean;
  /** Ranking resolution also accepts competition.score.write. */
  readonly canResolve?: boolean;
}) {
  const config = live.config;
  const round = live.round;
  const [judges, setJudges] = useState<readonly JudgeDraft[]>(() =>
    Array.from({ length: config.judgeCount }, (_, index) => ({
      judgeId: `judge-${index + 1}`,
      seatKey: `seat-${index + 1}`,
    })),
  );
  const [contestantId, setContestantId] = useState(state.participantIds[0] ?? "");
  const [nextContestantId, setNextContestantId] = useState("");
  const [busy, setBusy] = useState(false);
  const [reopenOpen, setReopenOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<void>, fallback: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await action();
      onChanged();
    } catch (caught) {
      setError(describeLiveError(caught, fallback));
    } finally {
      setBusy(false);
    }
  }

  function updateJudge(index: number, patch: Partial<JudgeDraft>): void {
    setJudges((current) =>
      current.map((judge, position) => (position === index ? { ...judge, ...patch } : judge)),
    );
  }

  function prepare(): Promise<void> {
    return run(() => prepareRound(state.activity.id, config.key).then(() => undefined), "准备回合失败。");
  }

  function activate(): Promise<void> {
    return run(
      () => activatePanel(state.activity.id, config.key, judges).then(() => undefined),
      "激活评委组失败。",
    );
  }

  function open(): Promise<void> {
    if (round === null || contestantId === "") return Promise.resolve();
    const existing = live.performances.find((item) => item.contestantId === contestantId);
    const sequence = existing?.sequence ??
      live.performances.reduce((highest, item) => Math.max(highest, item.sequence), 0) + 1;
    return run(
      () =>
        openPerformance(state.activity.id, config.key, {
          performanceId: existing?.id ?? crypto.randomUUID(),
          contestantId,
          sequence,
        }).then(() => undefined),
      "开表演失败。",
    );
  }

  function advance(): Promise<void> {
    const current = live.performances.find((performance) => performance.state === "open");
    if (current === undefined || nextContestantId === "") return Promise.resolve();
    const nextSequence = live.performances.reduce((highest, item) => Math.max(highest, item.sequence), 0) + 1;
    return run(
      () =>
        advancePerformance(state.activity.id, config.key, current.id, {
          nextContestantId,
          nextSequence,
        }).then(() => undefined),
      "切换下一位失败。",
    );
  }

  function lockOne(performanceId: string): Promise<void> {
    return run(
      () => lockPerformance(state.activity.id, config.key, performanceId).then(() => undefined),
      "锁表演失败。",
    );
  }

  function lockCurrentRound(): Promise<void> {
    if (round === null) return Promise.resolve();
    return run(
      () => lockRound(state.activity.id, config.key, round.revision).then(() => undefined),
      "锁轮失败。",
    );
  }

  function resolve(): Promise<void> {
    return run(() => resolveRound(state.activity.id, config.key).then(() => undefined), "生成排名失败。");
  }

  function reopenForCorrection(reason: string): Promise<void> {
    if (round === null) return Promise.resolve();
    return run(
      () => reopenRoundForCorrection(state.activity.id, config.key, round.revision, reason).then(() => undefined),
      "打开评分更正窗口失败。",
    );
  }

  function reset(): Promise<void> {
    if (round === null || (sessionMode !== "test" && sessionMode !== "rehearsal")) {
      return Promise.resolve();
    }
    return run(
      () => resetRehearsal(state.activity.id, config.key, sessionMode).then(() => undefined),
      "重置排练失败。",
    );
  }

  const allLocked = live.performances.length > 0 &&
    live.performances.every((performance) => performance.state === "locked");
  const openPerformanceRow = live.performances.find((performance) => performance.state === "open");
  const displayRanks = live.ranking === null
    ? []
    : liveDisplayRanks(live.ranking.rows, live.ranking.tieGroups);

  return (
    <Card className="live-round-card" data-testid={`live-round-${config.key}`}>
      <h2 className="ui-card__title">
        {config.key} · {round?.state ?? "未准备"}
      </h2>
      <p className="ui-card__description">
        评委 {config.judgeCount} 人 · 最少 {config.minimumJudges} 人 · {config.scoringMethod} · 晋级{" "}
        {config.advanceCount}
        {round === null ? "" : ` · revision ${round.revision}`}
      </p>

      {round === null && canPrepare ? (
        <Button variant="primary" disabled={busy} onClick={() => void prepare()}>
          准备回合
        </Button>
      ) : null}

      {round !== null && live.panel === null && canManageSetup ? (
        <div className="panel-form">
          <p className="ui-card__description">评委组（judgeId / seatKey）</p>
          {judges.map((judge, index) => (
            <div className="judge-row" key={index}>
              <Input
                label={`评委 ${index + 1} 标识`}
                value={judge.judgeId}
                onChange={(event) => updateJudge(index, { judgeId: event.target.value })}
              />
              <Input
                label={`评委 ${index + 1} 座位键`}
                value={judge.seatKey}
                onChange={(event) => updateJudge(index, { seatKey: event.target.value })}
              />
            </div>
          ))}
          <Button variant="primary" disabled={busy} onClick={() => void activate()}>
            激活评委组
          </Button>
        </div>
      ) : null}

      {live.panel === null ? null : (
        <div className="panel-summary">
          <p className="ui-card__description">
            评委组 {live.panel.id.slice(0, 12)} · expected {live.panel.expectedJudges} · context v
            {live.panel.contextVersion}
          </p>
          <ul className="seat-list">
            {live.seats.map((seat) => (
              <li key={seat.id}>
                <span>
                  {seat.seatKey || "—"} · {seat.judgeId}
                </span>
                <Badge tone={seat.state === "assigned" ? "success" : "neutral"}>
                  {seat.state}
                </Badge>
              </li>
            ))}
          </ul>
        </div>
      )}

      {round !== null && live.panel !== null && round.state === "scoring" && canManageSetup ? (
        <div className="performance-form">
          <Select
            label="开表演选手"
            value={contestantId}
            onChange={(event) => setContestantId(event.target.value)}
          >
            {state.participantIds.map((participantId) => (
              <option key={participantId} value={participantId}>
                {state.participantNames[participantId] ?? participantId}
              </option>
            ))}
          </Select>
          <Button
            variant="primary"
            disabled={busy || contestantId === "" || openPerformanceRow !== undefined}
            onClick={() => void open()}
          >
            开表演
          </Button>
        </div>
      ) : null}

      {openPerformanceRow !== undefined && canManageSetup ? (
        <div className="performance-form">
          <Select
            label="下一位选手"
            value={nextContestantId}
            onChange={(event) => setNextContestantId(event.target.value)}
          >
            <option value="">选择下一位</option>
            {state.participantIds
              .filter((participantId) => live.performances.every((item) => item.contestantId !== participantId))
              .map((participantId) => (
                <option key={participantId} value={participantId}>
                  {state.participantNames[participantId] ?? participantId}
                </option>
              ))}
          </Select>
          <Button
            variant="secondary"
            disabled={busy || nextContestantId === ""}
            onClick={() => void advance()}
          >
            锁定当前并切到下一位
          </Button>
        </div>
      ) : null}

      {live.performances.length === 0 ? null : (
        <Table caption="表演与评分进度">
          <thead>
            <tr>
              <th scope="col">序号</th>
              <th scope="col">选手</th>
              <th scope="col">状态</th>
              <th scope="col">评分进度</th>
              <th scope="col">操作</th>
            </tr>
          </thead>
          <tbody>
            {live.performances.map((performance) => (
              <tr key={performance.id}>
                <td data-label="序号">{performance.sequence}</td>
                <td data-label="选手">{state.participantNames[performance.contestantId] ?? performance.contestantId}</td>
                <td data-label="状态">{performance.state}</td>
                <td data-label="评分进度" data-testid={`score-count-${performance.contestantId}`}>
                  {performance.scoreCount}/{performance.expectedJudges}
                </td>
                <td data-label="操作">
                  {performance.state === "open" && canManageSetup ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={busy}
                      onClick={() => void lockOne(performance.id)}
                    >
                      锁表演
                    </Button>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      {round !== null && (canManageSetup || canResolve) ? (
        <div className="session-controls live-round-actions">
          {canManageSetup ? (
            <Button
              variant="secondary"
              disabled={busy || round.state !== "scoring" || !allLocked}
              onClick={() => void lockCurrentRound()}
            >
              锁轮
            </Button>
          ) : null}
          {canResolve ? (
            <Button
              variant="primary"
              disabled={busy || live.performances.length === 0 || openPerformanceRow !== undefined}
              onClick={() => void resolve()}
            >
              生成排名
            </Button>
          ) : null}
          {canManageSetup && sessionMode === "formal" && round.state === "locked" ? (
            <Button variant="secondary" disabled={busy} onClick={() => setReopenOpen(true)}>
              打开评分更正窗口
            </Button>
          ) : null}
        </div>
      ) : null}

      {live.ranking === null ? null : (
        <div className="ranking-block">
          <Table caption={`当前排名（revision ${live.ranking.revision}）`}>
            <thead>
              <tr>
                <th scope="col">名次</th>
                <th scope="col">选手</th>
                <th scope="col">总分</th>
                <th scope="col">评委数</th>
              </tr>
            </thead>
            <tbody>
              {live.ranking.rows.map((row, index) => (
                <tr key={row.contestantId}>
                  <td data-label="名次">{displayRanks[index] ?? index + 1}</td>
                  <td data-label="选手">{state.participantNames[row.contestantId] ?? row.contestantId}</td>
                  <td data-label="总分">{row.total}</td>
                  <td data-label="评委数">{row.judgeCount}</td>
                </tr>
              ))}
            </tbody>
          </Table>
          {live.ranking.tieGroups.length === 0 ? null : (
            <p className="ui-field__error" role="alert">
              存在同分：{live.ranking.tieGroups.map((group) => group.contestants.join(" / ")).join("；")}
            </p>
          )}
        </div>
      )}

      {round !== null && canManageSetup && (sessionMode === "test" || sessionMode === "rehearsal") ? (
        <div className="session-controls">
          <Button variant="danger" disabled={busy} onClick={() => setResetOpen(true)}>
            重置排练
          </Button>
        </div>
      ) : null}

      {error === null ? null : (
        <p className="ui-field__error" role="alert">
          {error}
        </p>
      )}

      <ReasonDialog
        open={reopenOpen}
        title="重新打开本轮"
        description="轮次会回到评分状态，所有修正都会留下审计记录。"
        label="审计原因"
        defaultValue="发布前核对评委评分"
        confirmLabel="重新打开"
        onCancel={() => setReopenOpen(false)}
        onConfirm={(reason) => {
          setReopenOpen(false);
          void reopenForCorrection(reason);
        }}
      />

      <ConfirmDialog
        open={resetOpen}
        title="清空排练数据？"
        description="本回合的排练分数会被清除，并回到准备状态。"
        confirmLabel="清空并回到准备状态"
        danger
        onCancel={() => setResetOpen(false)}
        onConfirm={() => {
          setResetOpen(false);
          void reset();
        }}
      />
    </Card>
  );
}
