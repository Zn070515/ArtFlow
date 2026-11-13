import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useState, type JSX, type ReactNode } from "react";

import { ApiError } from "../../api/client.js";
import {
  decideTie,
  describeLiveError,
  fetchRoundScores,
  finalizeAdvancement,
  type LiveRound,
  type LiveState,
  type RoundScoresResponse,
} from "../../api/live.js";
import { Button } from "../ui/Button.js";
import { Card } from "../ui/Card.js";
import { Input } from "../ui/Input.js";

type Ranking = NonNullable<RoundScoresResponse["ranking"]>;
type TieGroup = Ranking["tieGroups"][number];
type Advancement = NonNullable<RoundScoresResponse["advancement"]>;

function orderMatches(order: readonly string[], contestants: readonly string[]): boolean {
  return order.length === contestants.length &&
    contestants.every((contestantId) => order.includes(contestantId));
}

export function LiveTieAdvancementPanel({
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
  const [orders, setOrders] = useState<Record<string, readonly string[]>>({});
  const [reason, setReason] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ["round-scores", activityId, live.config.key, live.round?.revision],
    queryFn: () => fetchRoundScores(activityId, live.config.key),
    enabled: live.round !== null,
    retry: false,
    placeholderData: keepPreviousData,
  });

  const ranking: Ranking | null = query.data?.ranking ?? null;
  const advancement: Advancement | null = query.data?.advancement ?? null;

  function complete(message: string): void {
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
    // Polling mode may have missed a ranking revision or tie decision. Refresh
    // the projection so the operator acts on the current snapshot.
    if (
      caught instanceof ApiError &&
      (caught.code === "STALE_REVISION" || caught.code === "STALE_RESOLUTION_INPUT")
    ) {
      void query.refetch();
    }
  }

  function orderFor(group: TieGroup): readonly string[] {
    const current = orders[group.id];
    return current !== undefined && orderMatches(current, group.contestants)
      ? current
      : group.contestants;
  }

  function move(group: TieGroup, index: number, delta: number): void {
    const order = orderFor(group);
    const target = index + delta;
    if (target < 0 || target >= order.length) return;
    const next = [...order];
    const [moved] = next.splice(index, 1);
    if (moved === undefined) return;
    next.splice(target, 0, moved);
    setOrders((current) => ({ ...current, [group.id]: next }));
  }

  const decide = useMutation({
    mutationFn: (group: TieGroup) => {
      if (ranking === null) throw new Error("排名尚未加载。");
      return decideTie(activityId, live.config.key, {
        tieId: group.id,
        rankingSnapshotId: ranking.id,
        inputFingerprint: ranking.inputFingerprint,
        contestants: group.contestants,
        order: orderFor(group),
        reason: reason.trim(),
      });
    },
    onSuccess: () => {
      setReason("");
      complete("已记录裁决，请定稿晋级。");
    },
    onError: fail,
  });

  const finalize = useMutation({
    mutationFn: () => {
      if (ranking === null) throw new Error("排名尚未加载。");
      return finalizeAdvancement(activityId, live.config.key, ranking.revision);
    },
    onSuccess: () => complete("晋级已定稿。"),
    onError: fail,
  });

  const crossing = ranking === null
    ? []
    : ranking.tieGroups.filter((group) => {
        const start = ranking.rows.findIndex((row) => group.contestants.includes(row.contestantId));
        const advanceCount = query.data?.round.advanceCount ?? 0;
        return start >= 0 && start < advanceCount && start + group.contestants.length > advanceCount;
      });

  const staleAdvancement =
    ranking !== null && advancement !== null &&
    advancement.inputFingerprint !== ranking.inputFingerprint;
  const finalized =
    ranking !== null && advancement !== null &&
    (advancement.status === "auto" || advancement.status === "finalized") &&
    advancement.inputFingerprint === ranking.inputFingerprint;
  // A hold caused by a non-crossing tie is still auto-advanceable: the
  // backend reviews only ties that cross the cutoff. Gate on the crossing
  // ties the operator can see, not on the raw ranking status.
  const canFinalize =
    ranking !== null &&
    crossing.length === 0 &&
    !finalized &&
    !finalize.isPending;

  function renderAdvancementMessage(): ReactNode {
    if (advancement === null) {
      return <p className="ui-card__description">尚未定稿晋级。</p>;
    }
    if (staleAdvancement) {
      return (
        <p className="ui-field__error" role="alert">
          晋级名单已过期，请重新定稿。
        </p>
      );
    }
    if (finalized) {
      return <p className="ui-card__description">已定稿（revision {advancement.revision}）</p>;
    }
    if (advancement.status === "needs_review") {
      return (
        <p className="ui-card__description">
          {crossing.length === 0
            ? "上次定稿未完成；现在可以重新定稿。"
            : "上次定稿未完成，请先裁决平局。"}
        </p>
      );
    }
    return null;
  }

  function renderRanking(data: RoundScoresResponse): ReactNode {
    return (
      <>
        {crossing.length === 0 ? null : (
          <div className="live-exception-group">
            <p className="ui-card__description">
              晋级线附近有平局（{data.round.advanceCount} 个晋级名额），需先记录裁决。
            </p>
            {crossing.map((group) => {
              const order = orderFor(group);
              return (
                <div
                  className="live-exception-fact"
                  data-testid={`tie-group-${group.id}`}
                  key={group.id}
                >
                  <div className="live-exception-meta">
                    <strong>同分 {group.total}</strong>
                  </div>
                  <ol>
                    {order.map((contestantId, index) => (
                      <li className="live-exception-actions" key={contestantId}>
                        <span>{state.participantNames[contestantId] ?? contestantId}</span>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={index === 0 || decide.isPending}
                          onClick={() => move(group, index, -1)}
                        >
                          上移
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={index === order.length - 1 || decide.isPending}
                          onClick={() => move(group, index, 1)}
                        >
                          下移
                        </Button>
                      </li>
                    ))}
                  </ol>
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={reason.trim() === "" || decide.isPending}
                    onClick={() => decide.mutate(group)}
                  >
                    记录裁决
                  </Button>
                </div>
              );
            })}
            <Input
              label="裁决原因"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </div>
        )}
        {renderAdvancementMessage()}
        <Button
          variant="primary"
          size="sm"
          disabled={!canFinalize}
          onClick={() => finalize.mutate()}
        >
          晋级定稿
        </Button>
      </>
    );
  }

  let body: ReactNode;
  if (live.round === null) {
    body = <p className="ui-card__description">该轮次尚未准备。</p>;
  } else if (state.session?.mode !== "formal") {
    body = <p className="ui-card__description">仅正式模式可以裁决平局或定稿晋级。</p>;
  } else if (query.isPending) {
    body = <p className="ui-card__description">正在加载排名…</p>;
  } else if (query.isError) {
    body = (
      <div className="live-exception-error" role="alert">
        <p className="ui-field__error">
          {describeLiveError(query.error, "排名加载失败，请稍后重试。")}
        </p>
        <Button variant="secondary" size="sm" onClick={() => void query.refetch()}>
          重试
        </Button>
      </div>
    );
  } else if (query.data === undefined) {
    body = <p className="ui-card__description">正在加载排名…</p>;
  } else if (query.data.ranking === null) {
    body = <p className="ui-card__description">先生成排名。</p>;
  } else {
    body = renderRanking(query.data);
  }

  return (
    <Card
      className="live-exception-panel"
      data-testid={`live-tie-advancement-${live.config.key}`}
    >
      <h2 className="ui-card__title">异常处理 · 平局与晋级 · {live.config.key}</h2>
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
