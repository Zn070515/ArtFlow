import { useEffect, useState } from "react";

import { ApiError } from "../../api/client.js";
import {
  closeStudioSession,
  startStudioSession,
  type StudioState,
} from "../../api/studio.js";

type Mode = "test" | "rehearsal" | "formal";

export function SessionPanel({
  state,
  onChanged,
}: {
  readonly state: StudioState;
  readonly onChanged: () => void;
}) {
  const active = state.releases.find((release) => release.active);
  const [scope, setScope] = useState(active?.declaredScopes[0] ?? "");
  // test is the least consequential mode, so an unchanged form never starts a
  // rehearsal or formal session by accident.
  const [mode, setMode] = useState<Mode>("test");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (active !== undefined && !active.declaredScopes.includes(scope)) {
      setScope(active.declaredScopes[0] ?? "");
    }
  }, [active, scope]);

  async function start(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await startStudioSession(state.activity.id, crypto.randomUUID(), scope, mode);
      setConfirming(false);
      onChanged();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "启动会话失败。");
    } finally {
      setBusy(false);
    }
  }

  async function close(sessionId: string, revision: number): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await closeStudioSession(state.activity.id, sessionId, crypto.randomUUID(), revision);
      onChanged();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "关闭会话失败。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="ops-card">
      <p className="eyebrow">SESSIONS · 执行</p>
      <h2 className="console-card-title">执行会话</h2>
      {active === undefined ? (
        <p className="state-copy">先发布一个定义，才能启动会话。</p>
      ) : (
        <div className="session-controls">
          <label className="field">
            <span>Scope</span>
            <select
              value={scope}
              onChange={(event) => {
                setScope(event.target.value);
                setConfirming(false);
              }}
            >
              {active.declaredScopes.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Mode</span>
            <select
              value={mode}
              onChange={(event) => {
                setMode(event.target.value as Mode);
                setConfirming(false);
              }}
            >
              <option value="test">test</option>
              <option value="rehearsal">rehearsal</option>
              <option value="formal">formal</option>
            </select>
          </label>
          {confirming ? (
            <div className="session-confirm" role="group" aria-label="确认启动会话">
              <p className="state-copy">
                将启动 {scope} · {mode} 会话。
                {mode === "formal"
                  ? " formal 会话会写入正式事实，不能当作彩排重复运行。"
                  : mode === "rehearsal"
                    ? " 彩排事实与正式事实分开保存。"
                    : " test 只用于试跑，建议先确认流程。"}
              </p>
              <button
                className="primary-button"
                type="button"
                disabled={busy}
                onClick={() => void start()}
              >
                {busy ? "正在启动…" : `确认启动 ${mode} 会话`}
              </button>
              <button
                className="secondary-button"
                type="button"
                disabled={busy}
                onClick={() => setConfirming(false)}
              >
                取消
              </button>
            </div>
          ) : (
            <button
              className="primary-button"
              type="button"
              disabled={busy || scope === ""}
              onClick={() => setConfirming(true)}
            >
              启动会话
            </button>
          )}
        </div>
      )}
      {state.sessions.length === 0 ? null : (
        <ul className="session-list">
          {state.sessions.map((session) => (
            <li key={session.id}>
              <span>
                {session.scope} · {session.mode} · {session.status}
              </span>
              {session.status === "running" ? (
                <button
                  className="secondary-button"
                  type="button"
                  disabled={busy}
                  onClick={() => void close(session.id, session.revision)}
                >
                  关闭
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {error === null ? null : (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
