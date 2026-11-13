import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useRef, useState, type JSX, type ReactNode } from "react";

import { ApiError } from "../../api/client.js";
import {
  closeScoreCorrection,
  describeLiveError,
  editScoreFact,
  fetchRoundScores,
  openScoreCorrection,
  recalculateAfterCorrection,
  type LiveRound,
  type LiveState,
  type RoundScoresResponse,
} from "../../api/live.js";
import { Button } from "../ui/Button.js";
import { Card } from "../ui/Card.js";
import { Input } from "../ui/Input.js";

type ScoreFact = RoundScoresResponse["facts"][number];
type ScoreCorrection = NonNullable<ScoreFact["correction"]>;

const CORRECTION_STATUS: Record<ScoreCorrection["state"], string> = {
  open: "修正中",
  revised: "已改分",
  closed: "已关闭",
  recalculated: "已重算",
  cancelled: "已取消",
};

const CORRECTION_ERROR_MESSAGES: Record<string, string> = {
  RESULT_CONSUMED: "该赛段结果已确认，请先解锁赛果。",
  SESSION_NOT_RUNNING: "请先启动评分会话。",
  STALE_REVISION: "数据已变化，请刷新后重试。",
  STALE_CONTEXT: "数据已变化，请刷新后重试。",
  CORRECTION_REQUIRED: "修正状态已变化，请刷新后重试。",
  CORRECTION_ALREADY_OPEN: "修正状态已变化，请刷新后重试。",
  PERFORMANCE_SCORE_OPEN: "请先锁定表演评分。",
};

function correctionStatusLabel(correction: ScoreFact["correction"]): string {
  return correction === null ? "未修正" : CORRECTION_STATUS[correction.state];
}

function describeCorrectionError(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    const mapped = CORRECTION_ERROR_MESSAGES[error.code];
    if (mapped !== undefined) return mapped;
  }
  return describeLiveError(error, fallback);
}

function keepOnly<T>(current: Record<string, T>, ids: ReadonlySet<string>): Record<string, T> {
  let changed = false;
  const next: Record<string, T> = {};
  for (const [key, value] of Object.entries(current)) {
    if (ids.has(key)) {
      next[key] = value;
    } else {
      changed = true;
    }
  }
  return changed ? next : current;
}

export function LiveExceptionPanel({
  activityId,
  live,
  state,
  onChanged,
}: {
  readonly activityId: string;
  readonly live: LiveRound;
  readonly state: LiveState;
  readonly onChanged: () => void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const [openFactId, setOpenFactId] = useState<string | null>(null);
  const [openReason, setOpenReason] = useState("");
  const [criteriaDrafts, setCriteriaDrafts] = useState<Record<string, Record<string, string>>>({});
  const [criteriaErrors, setCriteriaErrors] = useState<Record<string, string>>({});
  const [editReasons, setEditReasons] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ["round-scores", activityId, live.config.key, live.round?.revision],
    queryFn: () => fetchRoundScores(activityId, live.config.key),
    enabled: live.round !== null,
    retry: false,
    placeholderData: keepPreviousData,
  });

  const lastCorrectionKey = useRef<string | null>(null);
  const activeCorrectionKey = query.data === undefined
    ? null
    : query.data.facts
        .map((fact) => fact.correction?.id ?? "")
        .filter((id) => id !== "")
        .sort()
        .join("|");

  useEffect(() => {
    if (activeCorrectionKey === null) return;
    if (lastCorrectionKey.current === activeCorrectionKey) return;
    lastCorrectionKey.current = activeCorrectionKey;
    const ids = new Set<string>(
      activeCorrectionKey === "" ? [] : activeCorrectionKey.split("|"),
    );
    setCriteriaDrafts((current) => keepOnly(current, ids));
    setCriteriaErrors((current) => keepOnly(current, ids));
    setEditReasons((current) => keepOnly(current, ids));
  }, [activeCorrectionKey]);

  function finish(message: string): void {
    void queryClient.invalidateQueries({
      queryKey: ["round-scores", activityId, live.config.key],
    });
    onChanged();
    setError(null);
    setStatus(message);
  }

  function fail(caught: unknown): void {
    setStatus(null);
    setError(describeCorrectionError(caught, "操作失败，请稍后重试。"));
  }

  function clearCorrectionDraft(correctionId: string): void {
    setCriteriaDrafts((current) => {
      if (!(correctionId in current)) return current;
      const next = { ...current };
      delete next[correctionId];
      return next;
    });
    setCriteriaErrors((current) => {
      if (!(correctionId in current)) return current;
      const next = { ...current };
      delete next[correctionId];
      return next;
    });
    setEditReasons((current) => {
      if (!(correctionId in current)) return current;
      const next = { ...current };
      delete next[correctionId];
      return next;
    });
  }

  const openCorrection = useMutation({
    mutationFn: (input: {
      readonly performanceId: string;
      readonly scoreFactId: string;
      readonly panelSnapshotId: string;
      readonly reason: string;
    }) => openScoreCorrection(activityId, live.config.key, input),
    onSuccess: () => {
      setOpenFactId(null);
      setOpenReason("");
      finish("已打开评分修正，请填写修正后的分数。");
    },
    onError: fail,
  });

  const editCorrection = useMutation({
    mutationFn: (input: {
      readonly scoreFactId: string;
      readonly performanceId: string;
      readonly panelSnapshotId: string;
      readonly seatId: string;
      readonly contextVersion: number;
      readonly expectedVersion: number;
      readonly criteria: Record<string, number>;
      readonly reason: string;
      readonly correctionId: string;
    }) => editScoreFact(activityId, live.config.key, input),
    onSuccess: () => finish("修正已保存，请关闭修正窗口。"),
    onError: fail,
  });

  const closeCorrection = useMutation({
    mutationFn: (input: {
      readonly scoreFactId: string;
      readonly correctionId: string;
      readonly panelSnapshotId: string;
      readonly performanceId: string;
    }) => closeScoreCorrection(activityId, live.config.key, input),
    onSuccess: (_result, input) => {
      clearCorrectionDraft(input.correctionId);
      finish("修正已关闭，请重算。");
    },
    onError: fail,
  });

  const recalculate = useMutation({
    mutationFn: (input: {
      readonly scoreFactId: string;
      readonly correctionId: string;
      readonly panelSnapshotId: string;
      readonly performanceId: string;
    }) => recalculateAfterCorrection(activityId, live.config.key, input),
    onSuccess: (_result, input) => {
      clearCorrectionDraft(input.correctionId);
      finish("重算完成，请先「锁轮」再点「生成排名」。");
    },
    onError: fail,
  });

  function initialCriteriaDraft(fact: ScoreFact): Record<string, string> {
    const next: Record<string, string> = {};
    for (const criterion of state.config.rubric.criteria) {
      next[criterion.key] = String(fact.criteria[criterion.key] ?? 0);
    }
    return next;
  }

  function draftFor(fact: ScoreFact, correction: ScoreCorrection): Record<string, string> {
    return criteriaDrafts[correction.id] ?? initialCriteriaDraft(fact);
  }

  function editReasonFor(correction: ScoreCorrection): string {
    return editReasons[correction.id] ?? correction.reason;
  }

  function changeCriterion(
    fact: ScoreFact,
    correction: ScoreCorrection,
    key: string,
    value: string,
  ): void {
    setCriteriaDrafts((current) => {
      const base = current[correction.id] ?? initialCriteriaDraft(fact);
      return {
        ...current,
        [correction.id]: { ...base, [key]: value },
      };
    });
    setCriteriaErrors((current) => {
      if (!(correction.id in current)) return current;
      const next = { ...current };
      delete next[correction.id];
      return next;
    });
  }

  function validateCriteria(
    fact: ScoreFact,
    correction: ScoreCorrection,
  ): Record<string, number> | null {
    const draft = draftFor(fact, correction);
    const criteria: Record<string, number> = {};
    for (const criterion of state.config.rubric.criteria) {
      const raw = (draft[criterion.key] ?? "").trim();
      const parsed = Number(raw);
      if (raw === "" || !Number.isFinite(parsed)) {
        setCriteriaErrors((current) => ({
          ...current,
          [correction.id]: `请输入有效的「${criterion.key}」分数。`,
        }));
        return null;
      }
      if (criterion.minimum !== undefined && parsed < criterion.minimum) {
        setCriteriaErrors((current) => ({
          ...current,
          [correction.id]: `「${criterion.key}」必须在 ${criterion.minimum} 到 ${criterion.maximum} 之间。`,
        }));
        return null;
      }
      if (parsed > criterion.maximum) {
        setCriteriaErrors((current) => ({
          ...current,
          [correction.id]:
            criterion.minimum === undefined
              ? `「${criterion.key}」不能大于 ${criterion.maximum}。`
              : `「${criterion.key}」必须在 ${criterion.minimum} 到 ${criterion.maximum} 之间。`,
        }));
        return null;
      }
      criteria[criterion.key] = parsed;
    }
    return criteria;
  }

  function saveCorrection(fact: ScoreFact, correction: ScoreCorrection): void {
    const reason = editReasonFor(correction).trim();
    if (reason === "") return;
    const criteria = validateCriteria(fact, correction);
    if (criteria === null) return;
    setCriteriaErrors((current) => {
      if (!(correction.id in current)) return current;
      const next = { ...current };
      delete next[correction.id];
      return next;
    });
    editCorrection.mutate({
      scoreFactId: fact.id,
      performanceId: fact.performanceId,
      panelSnapshotId: fact.panelSnapshotId,
      seatId: fact.seatId,
      contextVersion: fact.contextVersion,
      expectedVersion: fact.version,
      criteria,
      reason,
      correctionId: correction.id,
    });
  }

  function renderFactActions(
    fact: ScoreFact,
    performanceState: RoundScoresResponse["performances"][number]["state"] | undefined,
  ): ReactNode {
    const correction = fact.correction;
    const canOpenNew =
      correction === null ||
      correction.state === "recalculated" ||
      correction.state === "cancelled";
    if (canOpenNew) {
      if (performanceState !== "locked") {
        return (
          <p className="ui-card__description">该表演尚未锁定，暂不能修正。</p>
        );
      }
      if (openFactId !== fact.id) {
        return (
          <Button
            variant="secondary"
            size="sm"
            disabled={openCorrection.isPending}
            onClick={() => {
              setOpenFactId(fact.id);
              setOpenReason("");
            }}
          >
            {correction === null ? "开修正" : "再次修正"}
          </Button>
        );
      }
      return (
        <>
          <Input
            label="修正原因"
            value={openReason}
            onChange={(event) => setOpenReason(event.target.value)}
          />
          <Button
            variant="primary"
            size="sm"
            disabled={openReason.trim() === "" || openCorrection.isPending}
            onClick={() =>
              openCorrection.mutate({
                performanceId: fact.performanceId,
                scoreFactId: fact.id,
                panelSnapshotId: fact.panelSnapshotId,
                reason: openReason.trim(),
              })
            }
          >
            确认开修正
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={openCorrection.isPending}
            onClick={() => {
              setOpenFactId(null);
              setOpenReason("");
            }}
          >
            取消
          </Button>
        </>
      );
    }

    if (correction.state === "open") {
      const draft = draftFor(fact, correction);
      const reason = editReasonFor(correction);
      const validationError = criteriaErrors[correction.id];
      return (
        <>
          <div className="live-exception-criteria">
            {state.config.rubric.criteria.map((criterion) => (
              <Input
                key={criterion.key}
                label={criterion.key}
                type="number"
                step="0.01"
                inputMode="decimal"
                min={criterion.minimum}
                max={criterion.maximum}
                value={draft[criterion.key] ?? ""}
                onChange={(event) =>
                  changeCriterion(fact, correction, criterion.key, event.target.value)
                }
              />
            ))}
          </div>
          <Input
            label="修正原因"
            value={reason}
            onChange={(event) => {
              const value = event.target.value;
              setEditReasons((current) => ({ ...current, [correction.id]: value }));
            }}
          />
          {validationError === undefined ? null : (
            <p className="ui-field__error" role="alert">
              {validationError}
            </p>
          )}
          <Button
            variant="primary"
            size="sm"
            disabled={reason.trim() === "" || editCorrection.isPending}
            onClick={() => saveCorrection(fact, correction)}
          >
            保存修正
          </Button>
        </>
      );
    }

    if (correction.state === "revised") {
      return (
        <Button
          variant="secondary"
          size="sm"
          disabled={closeCorrection.isPending}
          onClick={() =>
            closeCorrection.mutate({
              scoreFactId: fact.id,
              correctionId: correction.id,
              panelSnapshotId: fact.panelSnapshotId,
              performanceId: fact.performanceId,
            })
          }
        >
          关闭修正
        </Button>
      );
    }

    if (correction.state === "closed") {
      return (
        <Button
          variant="primary"
          size="sm"
          disabled={recalculate.isPending}
          onClick={() =>
            recalculate.mutate({
              scoreFactId: fact.id,
              correctionId: correction.id,
              panelSnapshotId: fact.panelSnapshotId,
              performanceId: fact.performanceId,
            })
          }
        >
          重算
        </Button>
      );
    }

    return null;
  }

  function renderFacts(data: RoundScoresResponse): ReactNode {
    const performanceStates = new Map(
      data.performances.map((performance) => [performance.id, performance.state] as const),
    );
    const performanceIds: string[] = [];
    for (const performance of data.performances) {
      performanceIds.push(performance.id);
    }
    for (const fact of data.facts) {
      if (!performanceIds.includes(fact.performanceId)) {
        performanceIds.push(fact.performanceId);
      }
    }
    const groups = performanceIds
      .map((performanceId) => ({
        performanceId,
        performance: data.performances.find((item) => item.id === performanceId) ?? null,
        facts: data.facts.filter((fact) => fact.performanceId === performanceId),
      }))
      .filter((group) => group.facts.length > 0);

    if (groups.length === 0) {
      return <p className="ui-card__description">当前轮次还没有评分事实。</p>;
    }

    return groups.map((group) => (
      <div className="live-exception-group" key={group.performanceId}>
        {group.facts.map((fact) => {
          const contestantId = group.performance?.contestantId ?? fact.contestantId;
          return (
            <div
              className="live-exception-fact"
              data-testid={`score-fact-${fact.id}`}
              data-contestant={fact.contestantId}
              key={fact.id}
            >
              <div className="live-exception-meta">
                <strong>{state.participantNames[contestantId] ?? contestantId}</strong>
                <span>
                  {fact.seatId} · {fact.source}
                </span>
                <span>总分 {fact.total}</span>
                <span>{correctionStatusLabel(fact.correction)}</span>
              </div>
              <div className="live-exception-actions">
                {renderFactActions(fact, performanceStates.get(fact.performanceId))}
              </div>
            </div>
          );
        })}
      </div>
    ));
  }

  const data = query.data;
  let body: ReactNode;
  if (live.round === null) {
    body = <p className="ui-card__description">该轮次尚未准备。</p>;
  } else if (live.round.state === "locked") {
    body = (
      <p className="ui-card__description">
        {state.session?.mode === "formal"
          ? "轮次已锁定。请先在轮次操作区点「打开评分更正窗口」，再回到这里修正。"
          : "轮次已锁定。"}
      </p>
    );
  } else if (query.isPending) {
    body = <p className="ui-card__description">正在加载评分事实…</p>;
  } else if (query.isError) {
    body = (
      <div className="live-exception-error" role="alert">
        <p className="ui-field__error">
          {describeCorrectionError(query.error, "评分事实加载失败，请稍后重试。")}
        </p>
        <Button variant="secondary" size="sm" onClick={() => void query.refetch()}>
          重试
        </Button>
      </div>
    );
  } else if (data === undefined) {
    body = <p className="ui-card__description">正在加载评分事实…</p>;
  } else if (data.session === null) {
    body = <p className="ui-card__description">当前没有运行中的评分会话。</p>;
  } else if (state.activity.status !== "active") {
    body = <p className="ui-card__description">活动不在进行中，不能修正评分。</p>;
  } else {
    body = renderFacts(data);
  }

  return (
    <Card className="live-exception-panel" data-testid={`live-exceptions-${live.config.key}`}>
      <h2 className="ui-card__title">异常处理 · 评分修正 · {live.config.key}</h2>
      {body}
      {status === null ? null : (
        <p className="ui-card__description" role="status">
          {status}
        </p>
      )}
      {error === null ? null : (
        <p className="ui-field__error" role="alert">
          {error}
        </p>
      )}
    </Card>
  );
}
