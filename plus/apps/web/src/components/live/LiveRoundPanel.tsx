import { useState } from "react";

import {
  activatePanel,
  describeLiveError,
  lockPerformance,
  lockRound,
  openPerformance,
  prepareRound,
  recordTieDecision,
  reopenRoundForCorrection,
  resetRehearsal,
  resolveRound,
  type LiveRound,
  type LiveState,
  type LiveTieGroup,
} from "../../api/live.js";
import { liveDisplayRanks } from "./ranking.js";

function TieDecisionControls({
  group,
  busy,
  onDecide,
}: {
  readonly group: LiveTieGroup;
  readonly busy: boolean;
  readonly onDecide: (order: readonly string[], reason: string, tieId: string) => void;
}) {
  const [order, setOrder] = useState<readonly string[]>(group.contestants);
  const [reason, setReason] = useState("");
  const tieId = group.id;
  if (tieId === undefined) return null;

  function move(index: number, delta: number): void {
    const next = index + delta;
    if (next < 0 || next >= order.length) return;
    const copy = [...order];
    const moved = copy[index];
    const displaced = copy[next];
    if (moved === undefined || displaced === undefined) return;
    copy[index] = displaced;
    copy[next] = moved;
    setOrder(copy);
  }

  return (
    <div className="tie-decision">
      <p className="state-copy">裁决顺序</p>
      <ol>
        {order.map((contestantId, index) => (
          <li key={contestantId}>
            <span>{contestantId}</span>
            <button type="button" className="secondary-button" disabled={busy || index === 0} onClick={() => move(index, -1)}>上移</button>
            <button type="button" className="secondary-button" disabled={busy || index === order.length - 1} onClick={() => move(index, 1)}>下移</button>
          </li>
        ))}
      </ol>
      <label className="field">
        <span>裁决原因</span>
        <input value={reason} onChange={(event) => setReason(event.target.value)} />
      </label>
      <button
        type="button"
        className="primary-button"
        disabled={busy || reason.trim() === ""}
        onClick={() => onDecide(order, reason.trim(), tieId)}
      >
        裁决同分
      </button>
    </div>
  );
}

interface JudgeDraft {
  readonly judgeId: string;
  readonly seatKey: string;
}

export function LiveRoundPanel({
  state,
  live,
  sessionMode,
  onChanged,
}: {
  readonly state: LiveState;
  readonly live: LiveRound;
  readonly sessionMode?: "test" | "rehearsal" | "formal";
  readonly onChanged: () => void;
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
  const [busy, setBusy] = useState(false);
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

  function decideTie(order: readonly string[], reason: string, tieId: string): Promise<void> {
    const ranking = live.ranking;
    const fingerprint = ranking?.inputFingerprint;
    if (round === null || ranking === null || fingerprint === undefined) return Promise.resolve();
    const group = ranking.tieGroups.find((item) => item.id === tieId);
    if (group === undefined) return Promise.resolve();
    return run(
      () => recordTieDecision(state.activity.id, config.key, tieId, {
        rankingSnapshotId: ranking.id,
        inputFingerprint: fingerprint,
        contestants: group.contestants,
        order,
        reason,
      }).then(() => undefined),
      "裁决同分失败。",
    );
  }

  function reopenForCorrection(): Promise<void> {
    if (round === null) return Promise.resolve();
    const reason = window.prompt("请输入重新打开本轮的审计原因：", "发布前核对评委评分");
    if (reason === null || reason.trim() === "") return Promise.resolve();
    return run(
      () => reopenRoundForCorrection(state.activity.id, config.key, round.revision, reason).then(() => undefined),
      "打开评分更正窗口失败。",
    );
  }

  function reset(): Promise<void> {
    if (round === null || (sessionMode !== "test" && sessionMode !== "rehearsal")) {
      return Promise.resolve();
    }
    if (!window.confirm("清空本回合排练数据并回到准备状态？")) return Promise.resolve();
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
    <section className="ops-card live-round-card" data-testid={`live-round-${config.key}`}>
      <p className="eyebrow">ROUND · {config.key}</p>
      <h2 className="console-card-title">
        {config.key} · {round?.state ?? "未准备"}
      </h2>
      <p className="state-copy">
        评委 {config.judgeCount} 人 · 最少 {config.minimumJudges} 人 · {config.scoringMethod} · 晋级{" "}
        {config.advanceCount}
        {round === null ? "" : ` · revision ${round.revision}`}
      </p>

      {round === null ? (
        <button className="primary-button" type="button" disabled={busy} onClick={() => void prepare()}>
          准备回合
        </button>
      ) : null}

      {round !== null && live.panel === null ? (
        <div className="panel-form">
          <p className="state-copy">评委组（judgeId / seatKey）</p>
          {judges.map((judge, index) => (
            <div className="judge-row" key={index}>
              <label className="field">
                <span>评委 {index + 1} 标识</span>
                <input
                  value={judge.judgeId}
                  onChange={(event) => updateJudge(index, { judgeId: event.target.value })}
                />
              </label>
              <label className="field">
                <span>评委 {index + 1} 座位键</span>
                <input
                  value={judge.seatKey}
                  onChange={(event) => updateJudge(index, { seatKey: event.target.value })}
                />
              </label>
            </div>
          ))}
          <button className="primary-button" type="button" disabled={busy} onClick={() => void activate()}>
            激活评委组
          </button>
        </div>
      ) : null}

      {live.panel === null ? null : (
        <div className="panel-summary">
          <p className="state-copy">
            评委组 {live.panel.id.slice(0, 12)} · expected {live.panel.expectedJudges} · context v
            {live.panel.contextVersion}
          </p>
          <ul className="seat-list">
            {live.seats.map((seat) => (
              <li key={seat.id}>
                <span>
                  {seat.seatKey || "—"} · {seat.judgeId}
                </span>
                <span className={`status-badge status-${seat.state === "assigned" ? "approved" : "draft"}`}>
                  {seat.state}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {round !== null && live.panel !== null && round.state === "scoring" ? (
        <div className="performance-form">
          <label className="field">
            <span>开表演选手</span>
            <select value={contestantId} onChange={(event) => setContestantId(event.target.value)}>
              {state.participantIds.map((participantId) => (
                <option key={participantId} value={participantId}>
                  {participantId}
                </option>
              ))}
            </select>
          </label>
          <button
            className="primary-button"
            type="button"
            disabled={busy || contestantId === "" || openPerformanceRow !== undefined}
            onClick={() => void open()}
          >
            开表演
          </button>
        </div>
      ) : null}

      {live.performances.length === 0 ? null : (
        <div className="console-table-wrap">
          <table className="data-table">
            <caption>表演与评分进度</caption>
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
                  <td>{performance.sequence}</td>
                  <td>{performance.contestantId}</td>
                  <td>{performance.state}</td>
                  <td data-testid={`score-count-${performance.contestantId}`}>
                    {performance.scoreCount}/{performance.expectedJudges}
                  </td>
                  <td>
                    {performance.state === "open" ? (
                      <button
                        className="secondary-button"
                        type="button"
                        disabled={busy}
                        onClick={() => void lockOne(performance.id)}
                      >
                        锁表演
                      </button>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {round !== null ? (
        <div className="session-controls live-round-actions">
          <button
            className="secondary-button"
            type="button"
            disabled={busy || round.state !== "scoring" || !allLocked}
            onClick={() => void lockCurrentRound()}
          >
            锁轮
          </button>
          <button
            className="primary-button"
            type="button"
            disabled={busy || live.performances.length === 0 || openPerformanceRow !== undefined}
            onClick={() => void resolve()}
          >
            生成排名
          </button>
          {sessionMode === "formal" && round.state === "locked" ? (
            <button
              className="secondary-button"
              type="button"
              disabled={busy}
              onClick={() => void reopenForCorrection()}
            >
              打开评分更正窗口
            </button>
          ) : null}
        </div>
      ) : null}

      {live.ranking === null ? null : (
        <div className="ranking-block">
          <p className="eyebrow">RANKING · {live.ranking.status === "hold" ? "HOLD" : "READY"}</p>
          <div className="console-table-wrap">
            <table className="data-table">
              <caption>当前排名（revision {live.ranking.revision}）</caption>
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
                    <td>{displayRanks[index] ?? index + 1}</td>
                    <td>{row.contestantId}</td>
                    <td>{row.total}</td>
                    <td>{row.judgeCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {live.ranking.tieGroups.length === 0 ? null : (
            <p className="form-error" role="alert">
              存在同分：{live.ranking.tieGroups.map((group) => group.contestants.join(" / ")).join("；")}
            </p>
          )}
          {live.ranking.status === "ready" && state.activity.enabledCapabilities.includes("publishing") ? (
            <p className="state-copy">
              {sessionMode === "formal"
                ? "排名已生成。请到 Ops 核定并公示正式赛果。"
                : "排练排名不能公示。请在正式场次生成排名后，到 Ops 核定并公示。"}
              {" "}
              <a className="table-link" href={`/ops/${encodeURIComponent(state.activity.id)}`}>前往 Ops 核定并公示</a>
            </p>
          ) : null}
          {sessionMode === "formal" && live.ranking.tieGroups.length > 0 ? (
            live.ranking.tieGroups.map((group) => (
              <TieDecisionControls
                key={group.id ?? group.contestants.join("-")}
                group={group}
                busy={busy}
                onDecide={(order, reason, tieId) => {
                  void decideTie(order, reason, tieId);
                }}
              />
            ))
          ) : live.ranking.tieGroups.length > 0 ? (
            <p className="state-copy">排练场次不能裁决同分。请在正式场次处理。</p>
          ) : null}
        </div>
      )}

      {round !== null && (sessionMode === "test" || sessionMode === "rehearsal") ? (
        <div className="session-controls">
          <button className="danger-button" type="button" disabled={busy} onClick={() => void reset()}>
            重置排练
          </button>
        </div>
      ) : null}

      {error === null ? null : (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
