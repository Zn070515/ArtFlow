import { useState } from "react";

import {
  closeJudgeEntry,
  closeSession,
  describeLiveError,
  judgeEntryUrl,
  reissueJudgeEntry,
  startJudgingSession,
  type LiveSession,
  type LiveState,
} from "../../api/live.js";
import { Button } from "../ui/Button.js";
import { Card } from "../ui/Card.js";
import { Input } from "../ui/Input.js";
import { Select } from "../ui/Select.js";

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
  const [closeReason, setCloseReason] = useState("");
  const session = state.session;
  const ticketingEnabled = state.activity.enabledCapabilities.includes("ticketing");
  // Entry links are only claimable once a panel has created judge seats. Before
  // that the link resolves to SEAT_UNAVAILABLE with no visible warning, so the
  // control stays disabled and explains the prerequisite.
  const seatsReady = state.rounds.some((round) => round.seats.length > 0);

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

  function closeEntry(): Promise<void> {
    return run(async () => {
      await closeJudgeEntry(state.activity.id, closeReason.trim());
      setCloseReason("");
      setEntry(null);
      onChanged();
    }, "关闭评委入口失败。");
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
    <Card className="live-control-card" data-testid="live-session-panel">
      <h2 className="ui-card__title">judging 会话</h2>
      {session === null ? (
        <div className="session-controls">
          <Select
            label="Mode"
            className="session-control-field"
            value={mode}
            onChange={(event) => setMode(event.target.value as Mode)}
          >
            <option value="test">test</option>
            <option value="rehearsal">rehearsal</option>
            <option value="formal">formal</option>
          </Select>
          <Button variant="primary" disabled={busy} onClick={() => void start()}>
            启动评分会话
          </Button>
        </div>
      ) : (
        <div className="session-controls">
          <p className="ui-card__description" data-testid="live-session-status">
            judging · {session.mode} · {session.status}
          </p>
          <Button variant="secondary" disabled={busy} onClick={() => void stop()}>
            关闭会话
          </Button>
        </div>
      )}
      {session === null || !ticketingEnabled ? null : (
        <div className="session-controls">
          <Button
            variant="secondary"
            disabled={busy || !seatsReady}
            onClick={() => void generateLink()}
          >
            生成评委入口链接
          </Button>
          {seatsReady ? (
            <p className="ui-card__description">重新生成会让之前发出的旧链接失效。</p>
          ) : (
            <p className="ui-card__description">
              先在回合里激活评委组；席位就绪前生成的链接无法被评委使用。
            </p>
          )}
          <Input
            label="关闭评委入口的原因"
            className="session-control-field"
            value={closeReason}
            onChange={(event) => setCloseReason(event.target.value)}
            placeholder="例如：本场评委已全部入场"
          />
          <Button
            variant="secondary"
            disabled={busy || closeReason.trim() === ""}
            onClick={() => void closeEntry()}
          >
            关闭评委入口
          </Button>
        </div>
      )}
      {entry === null ? null : (
        <div className="judge-entry">
          <Input
            label={`评委入口链接（v${entry.version}）`}
            readOnly
            value={entry.url}
            aria-label="评委入口链接"
            onFocus={(event) => event.currentTarget.select()}
          />
          <a className="table-link" href={entry.url} target="_blank" rel="noreferrer">
            打开评委页
          </a>
        </div>
      )}
      {error === null ? null : (
        <p className="ui-field__error" role="alert">
          {error}
        </p>
      )}
    </Card>
  );
}
