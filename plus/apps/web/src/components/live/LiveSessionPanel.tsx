import { useState } from "react";

import {
  closeSession,
  describeLiveError,
  judgeEntryUrl,
  reissueJudgeEntry,
  startJudgingSession,
  type LiveSession,
  type LiveState,
} from "../../api/live.js";

type Mode = LiveSession["mode"];

export function LiveSessionPanel({
  state,
  onChanged,
}: {
  readonly state: LiveState;
  readonly onChanged: () => void;
}) {
  const [mode, setMode] = useState<Mode>("rehearsal");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [entry, setEntry] = useState<{ readonly version: number; readonly url: string } | null>(null);
  const session = state.session;

  async function run(action: () => Promise<void>, fallback: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(describeLiveError(caught, fallback));
    } finally {
      setBusy(false);
    }
  }

  function start(): Promise<void> {
    return run(async () => {
      await startJudgingSession(state.activity.id, mode);
      onChanged();
    }, "启动评分会话失败。");
  }

  function stop(): Promise<void> {
    if (session === null) return Promise.resolve();
    return run(async () => {
      await closeSession(state.activity.id, session.id, session.revision);
      onChanged();
    }, "关闭评分会话失败。");
  }

  function generateLink(): Promise<void> {
    return run(async () => {
      const result = await reissueJudgeEntry(state.activity.id);
      if (result.capability === null || result.capability === "") {
        throw new Error("该入口链接已生成过，请重新点击生成。");
      }
      setEntry({
        version: result.version,
        url: judgeEntryUrl(state.activity.publicCode, result.capability),
      });
    }, "生成评委入口链接失败。");
  }

  return (
    <section className="ops-card" data-testid="live-session-panel">
      <p className="eyebrow">SESSION · 评分会话</p>
      <h2>judging 会话</h2>
      {session === null ? (
        <div className="session-controls">
          <label className="field">
            <span>Mode</span>
            <select value={mode} onChange={(event) => setMode(event.target.value as Mode)}>
              <option value="test">test</option>
              <option value="rehearsal">rehearsal</option>
              <option value="formal">formal</option>
            </select>
          </label>
          <button className="primary-button" type="button" disabled={busy} onClick={() => void start()}>
            启动评分会话
          </button>
        </div>
      ) : (
        <div className="session-controls">
          <p className="state-copy" data-testid="live-session-status">
            judging · {session.mode} · {session.status}
          </p>
          <button className="secondary-button" type="button" disabled={busy} onClick={() => void stop()}>
            关闭会话
          </button>
        </div>
      )}
      {session === null ? null : (
        <div className="session-controls">
          <button className="secondary-button" type="button" disabled={busy} onClick={() => void generateLink()}>
            生成评委入口链接
          </button>
        </div>
      )}
      {entry === null ? null : (
        <div className="judge-entry">
          <label className="field">
            <span>评委入口链接（v{entry.version}）</span>
            <input readOnly value={entry.url} aria-label="评委入口链接" onFocus={(event) => event.currentTarget.select()} />
          </label>
          <a className="table-link" href={entry.url} target="_blank" rel="noreferrer">
            打开评委页
          </a>
        </div>
      )}
      {error === null ? null : (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
