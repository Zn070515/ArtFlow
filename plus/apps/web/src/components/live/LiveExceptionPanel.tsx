import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type JSX, type ReactNode } from "react";

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

function correctionStatusLabel(correction: ScoreFact["correction"]): string {
  return correction === null ? "未修正" : CORRECTION_STATUS[correction.state];
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
  const [criteriaDrafts, setCriteriaDrafts] = useState<Record<string, Record<string, number>>>({});
  const [editReasons, setEditReasons] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ["round-scores", activityId, live.config.key, live.round?.revision],
    queryFn: () => fetchRoundScores(activityId, live.config.key),
    enabled: live.round !== null,
    retry: false,
  });

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
    setError(describeLiveError(caught, "操作失败，请稍后重试。"));
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
    onSuccess: () => finish("修正已关闭，请重算。"),
    onError: fail,
  });

  const recalculate = useMutation({
    mutationFn: (input: {
      readonly scoreFactId: string;
      readonly correctionId: string;
      readonly panelSnapshotId: string;
      readonly performanceId: string;
    }) => recalculateAfterCorrection(activityId, live.config.key, input),
    onSuccess: () => finish("重算完成，请点击「生成排名」更新排名。"),
    onError: fail,
  });

  function initialCriteria(fact: ScoreFact): Record<string, number> {
    const next: Record<string, number> = {};
    for (const criterion of state.config.rubric.criteria) {
      next[criterion.key] = fact.criteria[criterion.key] ?? 0;
    }
    return next;
  }

  function draftFor(fact: ScoreFact): Record<string, number> {
    return criteriaDrafts[fact.id] ?? initialCriteria(fact);
  }

  function changeCriterion(fact: ScoreFact, key: string, value: string): void {
    setCriteriaDrafts((current) => {
      const base = current[fact.id] ?? initialCriteria(fact);
      const parsed = value === "" ? 0 : Number(value);
      return {
        ...current,
        [fact.id]: { ...base, [key]: Number.isNaN(parsed) ? 0 : parsed },
      };
    });
  }

  function editReasonFor(fact: ScoreFact, correction: ScoreCorrection): string {
    return editReasons[fact.id] ?? correction.reason;
  }

  function saveCorrection(fact: ScoreFact, correction: ScoreCorrection): void {
    const draft = draftFor(fact);
    const criteria: Record<string, number> = {};
    for (const criterion of state.config.rubric.criteria) {
      criteria[criterion.key] = draft[criterion.key] ?? 0;
    }
    const reason = editReasonFor(fact, correction).trim();
    if (reason === "") return;
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

  function renderFactActions(fact: ScoreFact): ReactNode {
    const correction = fact.correction;
    if (correction === null) {
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
            开修正
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
      const draft = draftFor(fact);
      const reason = editReasonFor(fact, correction);
      return (
        <>
          <div className="live-exception-criteria">
            {state.config.rubric.criteria.map((criterion) => (
              <Input
                key={criterion.key}
                label={criterion.key}
                type="number"
                value={draft[criterion.key] ?? 0}
                onChange={(event) => changeCriterion(fact, criterion.key, event.target.value)}
              />
            ))}
          </div>
          <Input
            label="修正原因"
            value={reason}
            onChange={(event) => {
              const value = event.target.value;
              setEditReasons((current) => ({ ...current, [fact.id]: value }));
            }}
          />
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

  function blockingCard(message: string): JSX.Element {
    return (
      <Card className="live-exception-panel">
        <h2 className="ui-card__title">异常处理 · 评分修正</h2>
        <p className="ui-card__description">{message}</p>
      </Card>
    );
  }

  if (live.round === null) {
    return blockingCard("该轮次尚未准备。");
  }
  if (live.round.state === "locked") {
    return blockingCard(
      "轮次已锁定。请先在轮次操作区点「打开评分更正窗口」，再回到这里修正。",
    );
  }

  const data = query.data;
  if (data === undefined || data.session === null) {
    return blockingCard("当前没有运行中的评分会话。");
  }
  if (state.activity.status !== "active") {
    return blockingCard("活动不在进行中，不能修正评分。");
  }

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

  return (
    <Card className="live-exception-panel" data-testid={`live-exceptions-${live.config.key}`}>
      <h2 className="ui-card__title">异常处理 · 评分修正</h2>
      <p className="ui-card__description">
        按表演列出评分事实；改分后请重算，再重新生成排名与锁轮。
      </p>
      {groups.length === 0 ? (
        <p className="ui-card__description">当前轮次还没有评分事实。</p>
      ) : (
        groups.map((group) => (
          <div className="live-exception-group" key={group.performanceId}>
            {group.facts.map((fact) => {
              const contestantId = group.performance?.contestantId ?? fact.contestantId;
              return (
                <div
                  className="live-exception-fact"
                  data-testid={`score-fact-${fact.contestantId}`}
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
                  <div className="live-exception-actions">{renderFactActions(fact)}</div>
                </div>
              );
            })}
          </div>
        ))
      )}
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
