import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { ApiError } from "../api/client.js";
import {
  claimJudgeSeat,
  fetchJudgeContext,
  submitJudgeScore,
  type JudgeContext,
} from "../api/judge.js";
import { JUDGING_SCOPE } from "../api/live.js";

type ClaimState =
  | { readonly status: "idle" }
  | { readonly status: "claiming" }
  | { readonly status: "claimed" }
  | { readonly status: "failed"; readonly message: string };

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message;
  return fallback;
}

export function JudgePage() {
  const { publicCode } = useParams({ from: "/judge/$publicCode" });
  const search = useSearch({ from: "/judge/$publicCode" });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [claim, setClaim] = useState<ClaimState>(
    search.capability === undefined ? { status: "idle" } : { status: "claiming" },
  );
  const attempted = useRef(false);

  useEffect(() => {
    if (attempted.current) return;
    attempted.current = true;
    const capability = search.capability;
    if (capability === undefined || capability === "") return;
    setClaim({ status: "claiming" });
    void claimJudgeSeat(publicCode, capability)
      .then(() => {
        setClaim({ status: "claimed" });
        // The capability is single-use; keep it out of the address bar.
        void navigate({
          to: "/judge/$publicCode",
          params: { publicCode },
          search: { capability: undefined },
          replace: true,
        });
      })
      .catch((error: unknown) => {
        setClaim({
          status: "failed",
          message: errorMessage(error, "评委入口无法认领，请联系工作人员。"),
        });
      });
  }, [navigate, publicCode, search.capability]);

  const context = useQuery({
    queryKey: ["judge-context"],
    queryFn: fetchJudgeContext,
    enabled: claim.status !== "claiming",
    retry: false,
    refetchInterval: 3000,
  });

  if (claim.status === "claiming") {
    return <p className="console-state auth-loading">正在认领评委席位…</p>;
  }
  if (claim.status === "failed") {
    return (
      <section className="console-state">
        <p className="eyebrow">JUDGE</p>
        <h1 className="console-page-title">入口不可用</h1>
        <p className="form-error" role="alert">
          {claim.message}
        </p>
      </section>
    );
  }
  if (context.isPending) {
    return <p className="console-state auth-loading">正在加载评委上下文…</p>;
  }
  if (context.error !== null) {
    const unauthenticated = context.error instanceof ApiError && context.error.status === 401;
    return (
      <section className="console-state">
        <p className="eyebrow">JUDGE</p>
        <h1 className="console-page-title">{unauthenticated ? "需要评委入口链接" : "评委上下文不可用"}</h1>
        <p className="state-copy">
          {unauthenticated
            ? "请使用工作人员刚生成的评委入口链接打开本页。"
            : errorMessage(context.error, "请稍后刷新重试。")}
        </p>
      </section>
    );
  }

  return (
    <JudgeContent
      context={context.data}
      onScored={() => {
        void queryClient.invalidateQueries({ queryKey: ["judge-context"] });
      }}
    />
  );
}

function JudgeContent({
  context,
  onScored,
}: {
  readonly context: JudgeContext;
  readonly onScored: () => void;
}) {
  return (
    <section className="judge-page">
      <header className="console-page-header">
        <div>
          <p className="eyebrow">JUDGE · 评委评分</p>
          <h1 className="console-page-title">{context.activity.title}</h1>
          <p className="state-copy">
            公开码 {context.activity.publicCode} · 座位 {context.seat.seatKey}
            {context.seat.judgeId === null ? "" : ` · 评委 ${context.seat.judgeId}`}
          </p>
        </div>
      </header>
      <div className="judge-workspace">
        <div className="judge-score-column">
          <ScoreCard context={context} onScored={onScored} />
        </div>
        <section className="ops-card judge-status-panel">
          <p className="eyebrow">STATUS · 状态</p>
          <h2 className="console-card-title">本轮</h2>
          <p className="state-copy">
            回合 {context.round?.roundKey ?? "—"} · 评委组 {context.panel?.id.slice(0, 12) ?? "—"}
          </p>
          <p className="state-copy">
            {context.performance === null
              ? "等待下一位选手…"
              : `当前选手 ${context.performance.contestantId} · 第 ${context.performance.sequence} 位`}
          </p>
        </section>
      </div>
    </section>
  );
}

function ScoreCard({
  context,
  onScored,
}: {
  readonly context: JudgeContext;
  readonly onScored: () => void;
}) {
  const criteria = context.rubric?.criteria ?? [];
  const target = context.scoring;
  const performanceId = context.performance?.id ?? null;
  const [values, setValues] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const previous = context.existingScore;
    const next: Record<string, string> = {};
    for (const criterion of criteria) {
      const submitted = previous?.criteria[criterion.key];
      next[criterion.key] = submitted === undefined ? "" : String(submitted);
    }
    setValues(next);
    setNotes(previous?.notes ?? "");
    // Reset only when the performance changes; polling returns new objects.
  }, [performanceId, criteria.length]);

  async function submit(): Promise<void> {
    if (target === null) return;
    setBusy(true);
    setError(null);
    try {
      const parsed: Record<string, number> = {};
      for (const criterion of criteria) {
        const raw = values[criterion.key] ?? "";
        const value = Number(raw);
        if (raw.trim() === "" || !Number.isFinite(value)) {
          throw new Error(`请填写「${criterion.key}」。`);
        }
        if (value < (criterion.minimum ?? 0) || value > criterion.maximum) {
          throw new Error(`「${criterion.key}」需在 ${criterion.minimum ?? 0}–${criterion.maximum} 之间。`);
        }
        parsed[criterion.key] = value;
      }
      await submitJudgeScore({
        activityId: context.activity.id,
        roundKey: target.roundKey,
        performanceId: target.performanceId,
        panelSnapshotId: target.panelSnapshotId,
        seatId: target.seatId,
        contextVersion: target.contextVersion,
        criteria: parsed,
        notes,
        scope: JUDGING_SCOPE,
      });
      onScored();
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : caught instanceof Error
            ? caught.message
            : "评分提交失败。",
      );
    } finally {
      setBusy(false);
    }
  }

  if (context.performance === null) {
    return (
      <section className="ops-card judge-score-card" data-testid="judge-score-card">
        <p className="eyebrow">SCORE · 评分</p>
        <h2 className="console-card-title">等待选手</h2>
        <p className="state-copy">工作人员开表演后会自动出现评分表。</p>
      </section>
    );
  }
  if (target === null) {
    return (
      <section className="ops-card judge-score-card" data-testid="judge-score-card">
        <p className="eyebrow">SCORE · 评分</p>
        <h2 className="console-card-title">席位未就绪</h2>
        <p className="state-copy">本轮评委组尚未就绪，请等待工作人员处理。</p>
      </section>
    );
  }
  if (context.existingScore !== null) {
    return (
      <section className="ops-card judge-score-card" data-testid="judge-score-card">
        <p className="eyebrow">SCORE · 评分</p>
        <h2 className="console-card-title">已提交 · {context.existingScore.total}</h2>
        <p className="state-copy" data-testid="judge-submitted">
          {context.performance.contestantId} 已评分，等待下一位选手。
        </p>
        <ul className="seat-list">
          {criteria.map((criterion) => (
            <li key={criterion.key}>
              <span>{criterion.key}</span>
              <span>{context.existingScore?.criteria[criterion.key] ?? "—"}</span>
            </li>
          ))}
        </ul>
      </section>
    );
  }

  return (
    <section className="ops-card judge-score-card" data-testid="judge-score-card">
      <p className="eyebrow">SCORE · 评分</p>
      <h2 className="console-card-title">{context.performance.contestantId}</h2>
      <p className="state-copy">第 {context.performance.sequence} 位 · 三项满分制</p>
      <form
        className="auth-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {criteria.map((criterion) => (
          <label className="field" key={criterion.key}>
            <span>
              {criterion.key}（{criterion.minimum ?? 0}–{criterion.maximum}）
            </span>
            <input
              type="number"
              inputMode="decimal"
              min={criterion.minimum ?? 0}
              max={criterion.maximum}
              step="0.01"
              value={values[criterion.key] ?? ""}
              onChange={(event) =>
                setValues((current) => ({ ...current, [criterion.key]: event.target.value }))
              }
            />
          </label>
        ))}
        <label className="field">
          <span>备注</span>
          <textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={3} />
        </label>
        <button className="primary-button" type="submit" disabled={busy}>
          {busy ? "提交中…" : "提交评分"}
        </button>
      </form>
      {error === null ? null : (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
