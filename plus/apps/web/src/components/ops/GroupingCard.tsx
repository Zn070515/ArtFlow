import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

import { ApiError } from "../../api/client.js";
import {
  cancelGroupingStage,
  confirmGroupingStage,
  correctGroupingStage,
  createGroupingStage,
  fetchGrouping,
  freezeGroupingStage,
  recordGroupingGroups,
  setGroupingWindow,
} from "../../api/grouping.js";
import type { GroupingStage, GroupingWindow } from "../../api/grouping.js";
import { fetchOpsRegistrations } from "../../api/ops.js";
import { Button } from "../ui/Button.js";
import { Card } from "../ui/Card.js";
import { Input } from "../ui/Input.js";
import { Select } from "../ui/Select.js";

const STAGE_KEY = "chorus";
const STAGE_NAME = "分组合唱";

function commandId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function splitEvenly(participantIds: readonly string[], count: number): string[][] {
  const groups = Array.from({ length: count }, () => [] as string[]);
  participantIds.forEach((participantId, index) => {
    groups[index % count]?.push(participantId);
  });
  return groups;
}

function errorMessage(error: unknown): string {
  const code = error instanceof ApiError ? error.code : "";
  if (code === "GROUPING_INCOMPLETE") return "还有选手没有分到组。";
  if (code === "GROUPING_SOURCE_CHANGED") return "晋级名单变了，请重新确认。";
  if (code === "GROUPING_CONSUMED") return "结果已确认，不能再改分组。";
  if (code === "GROUPING_GROUP_COUNT") return "组数和规则要求不一致。";
  if (code === "GROUPING_SOURCE_UNKNOWN") return "名单还没有定稿。";
  return error instanceof Error ? error.message : String(error);
}

export function GroupingCard(props: { readonly activityId: string }) {
  const queryClient = useQueryClient();
  const state = useQuery({
    queryKey: ["grouping", props.activityId],
    queryFn: () => fetchGrouping(props.activityId),
    retry: false,
  });
  const participants = useQuery({
    queryKey: ["ops-registrations", props.activityId],
    queryFn: () => fetchOpsRegistrations(props.activityId),
    retry: false,
  });
  const [groupCount, setGroupCount] = useState(5);
  const [draft, setDraft] = useState<
    readonly { name: string; participantIds: readonly string[] }[] | null
  >(null);
  // Mutation responses carry the new revision; confirming from a stale query
  // would otherwise fail with STALE_REVISION while the refetch is in flight.
  const [latest, setLatest] = useState<GroupingStage | null>(null);
  const [editing, setEditing] = useState(false);
  const [reason, setReason] = useState("");
  const [windowState, setWindowState] = useState<GroupingWindow>("closed");

  const stage: GroupingStage | undefined = latest ?? state.data?.stages[0];

  useEffect(() => {
    if (stage !== undefined) setWindowState(stage.materialWindow);
  }, [stage?.id, stage?.materialWindow]);

  useEffect(() => {
    if (stage !== undefined && stage.groupCount !== null) setGroupCount(stage.groupCount);
  }, [stage?.id, stage?.groupCount]);

  const approved = (participants.data ?? []).filter((item) => item.status === "approved");
  const labels = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of approved) {
      const name = typeof item.answers.name === "string" ? item.answers.name : "";
      map.set(item.participantId, name || item.participantId);
    }
    return map;
  }, [approved]);

  const accept = (next: GroupingStage) => {
    setLatest(next);
    setDraft(null);
    void queryClient.invalidateQueries({ queryKey: ["grouping", props.activityId] });
  };

  // round_advanced grouping needs a source-participant read; deferred.
  const create = useMutation({
    mutationFn: () =>
      createGroupingStage(props.activityId, commandId("group-create"), {
        stageKey: STAGE_KEY,
        name: STAGE_NAME,
        rosterSource: "all_approved",
      }),
    onSuccess: accept,
  });

  const record = useMutation({
    mutationFn: (groups: readonly { name: string; participantIds: readonly string[] }[]) => {
      if (stage === undefined) throw new Error("赛段尚未创建。");
      return recordGroupingGroups(
        props.activityId,
        stage.id,
        commandId("group-record"),
        stage.revision,
        groups,
      );
    },
    onSuccess: accept,
  });

  const confirm = useMutation({
    mutationFn: () => {
      if (stage === undefined) throw new Error("赛段尚未创建。");
      return confirmGroupingStage(props.activityId, stage.id, commandId("group-confirm"), stage.revision);
    },
    onSuccess: accept,
  });

  const freeze = useMutation({
    mutationFn: () => {
      if (stage === undefined) throw new Error("赛段尚未创建。");
      return freezeGroupingStage(props.activityId, stage.id, commandId("group-freeze"), stage.revision);
    },
    onSuccess: accept,
  });

  const correct = useMutation({
    mutationFn: () => {
      if (stage === undefined) throw new Error("赛段尚未创建。");
      return correctGroupingStage(
        props.activityId,
        stage.id,
        commandId("group-correct"),
        stage.revision,
        groups,
        reason,
      );
    },
    onSuccess: (next) => {
      accept(next);
      setEditing(false);
      setReason("");
    },
  });

  const cancel = useMutation({
    mutationFn: () => {
      if (stage === undefined) throw new Error("赛段尚未创建。");
      return cancelGroupingStage(
        props.activityId,
        stage.id,
        commandId("group-cancel"),
        stage.revision,
        reason,
      );
    },
    onSuccess: (next) => {
      accept(next);
      setReason("");
    },
  });

  const changeWindow = useMutation({
    mutationFn: () => {
      if (stage === undefined) throw new Error("赛段尚未创建。");
      return setGroupingWindow(
        props.activityId,
        stage.id,
        commandId("group-window"),
        stage.revision,
        windowState,
      );
    },
    onSuccess: accept,
  });

  if (state.isError) return null;
  if (state.isLoading) {
    return (
      <Card className="grouping-card">
        <p className="auth-loading">正在读取分组…</p>
      </Card>
    );
  }

  const groups =
    draft ??
    stage?.groups.map((group) => ({
      name: group.name,
      participantIds: group.members.map((member) => member.participantId),
    })) ??
    [];
  const assigned = groups.reduce((total, group) => total + group.participantIds.length, 0);
  const noGroups = groups.length === 0;
  const hasEmptyGroup = groups.some((group) => group.participantIds.length === 0);
  const groupCountMismatch =
    stage?.groupCount !== null &&
    stage?.groupCount !== undefined &&
    groups.length !== stage.groupCount;
  // A local draft is not saved yet; confirming or freezing now would act on
  // the previous server-side grouping.
  const dirty = draft !== null || editing;
  const canSave = !noGroups && !hasEmptyGroup;
  const canConfirm = !dirty && canSave && !groupCountMismatch;
  const error =
    create.error ??
    record.error ??
    confirm.error ??
    freeze.error ??
    correct.error ??
    cancel.error ??
    changeWindow.error;

  return (
    <Card className="grouping-card">
      <h2 className="ui-card__title">第一轮分组</h2>

      {stage === undefined ? (
        <Button variant="primary" onClick={() => create.mutate()}>
          创建分组赛段
        </Button>
      ) : (
        <>
          <p className="ui-card__description">
            状态：{stage.status} · 已分 {assigned}/{approved.length} 人
            {stage.groupCount === null ? "" : ` · 规则要求 ${stage.groupCount} 组`}
          </p>

          {stage.status === "draft" || editing ? (
            <>
              <Input
                type="number"
                min={1}
                label="组数"
                value={groupCount}
                onChange={(event) => setGroupCount(Number(event.target.value))}
              />
              <Button
                variant="secondary"
                disabled={participants.isPending}
                onClick={() =>
                  setDraft(
                    splitEvenly(
                      approved.map((item) => item.participantId),
                      Math.min(Math.max(1, groupCount), Math.max(1, approved.length)),
                    ).map((participantIds, index) => ({
                      name: `第 ${index + 1} 组`,
                      participantIds,
                    })),
                  )
                }
              >
                自动平均分组
              </Button>
            </>
          ) : null}

          <div className="grouping-grid">
            {groups.map((group) => (
              <article key={group.name} className="grouping-group">
                <strong>{group.name}</strong>
                <ul>
                  {group.participantIds.map((participantId) => (
                    <li key={participantId}>
                      {labels.get(participantId) ?? participantId}
                      {stage.status === "draft" || editing ? (
                        <select
                          className="ui-select"
                          aria-label={`调整 ${participantId}`}
                          value={group.name}
                          onChange={(event) => {
                            const target = event.target.value;
                            setDraft(
                              groups.map((item) => ({
                                name: item.name,
                                participantIds:
                                  item.name === target
                                    ? [...item.participantIds, participantId]
                                    : item.participantIds.filter((id) => id !== participantId),
                              })),
                            );
                          }}
                        >
                          {groups.map((item) => (
                            <option key={item.name} value={item.name}>{item.name}</option>
                          ))}
                        </select>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </article>
            ))}
          </div>

          {stage.status === "draft" ? (
            <Button
              variant="primary"
              disabled={record.isPending || !canSave}
              onClick={() => record.mutate(groups)}
            >
              保存分组
            </Button>
          ) : null}
          {noGroups ? (
            <p className="ui-card__description">先点「自动平均分组」或手动把选手分到组里。</p>
          ) : hasEmptyGroup ? (
            <p className="ui-card__description">有小组还没有成员，先调整再保存。</p>
          ) : null}
          {stage.status === "draft" ? (
            <Button
              variant="primary"
              disabled={confirm.isPending || !canConfirm}
              onClick={() => confirm.mutate()}
            >
              确认分组
            </Button>
          ) : null}
          {stage.status === "draft" && dirty && canSave ? (
            <p className="ui-card__description">先保存当前分组，再确认。</p>
          ) : null}
          {groupCountMismatch && stage.groupCount !== null ? (
            <p className="ui-card__description">
              规则要求 {stage.groupCount} 组，当前是 {groups.length} 组；请调整分组或修改赛制。
            </p>
          ) : null}
          {stage.status === "confirmed" ? (
            <Button variant="primary" disabled={freeze.isPending || dirty} onClick={() => freeze.mutate()}>
              冻结分组
            </Button>
          ) : null}
          {stage.status === "confirmed" && dirty ? (
            <p className="ui-card__description">先保存当前修正，再冻结。</p>
          ) : null}
          {stage.status === "frozen" ? <p className="ui-card__description">分组已冻结。</p> : null}

          {stage.status !== "cancelled" ? (
            <details className="grouping-more">
              <summary>更多操作</summary>
              {stage.status === "confirmed" || stage.status === "frozen" ? (
                <>
                  <Select
                    label="材料窗口"
                    value={windowState}
                    onChange={(event) => setWindowState(event.target.value as GroupingWindow)}
                  >
                    <option value="closed">关闭</option>
                    <option value="open">开放提交</option>
                    <option value="supplement_only">仅补交</option>
                  </Select>
                  <Button
                    variant="secondary"
                    disabled={changeWindow.isPending}
                    onClick={() => changeWindow.mutate()}
                  >
                    应用材料窗口
                  </Button>
                </>
              ) : null}

              <Input
                label="原因"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="修正或取消必须填写"
              />

              {stage.status === "confirmed" || stage.status === "frozen" ? (
                editing ? (
                  <Button
                    variant="secondary"
                    disabled={
                      correct.isPending ||
                      !canSave ||
                      groupCountMismatch ||
                      reason.trim() === ""
                    }
                    onClick={() => correct.mutate()}
                  >
                    保存修正
                  </Button>
                ) : (
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setDraft(groups);
                      setEditing(true);
                    }}
                  >
                    修正分组
                  </Button>
                )
              ) : null}

              {stage.status === "draft" || stage.status === "confirmed" ? (
                <Button
                  variant="secondary"
                  disabled={cancel.isPending || reason.trim() === ""}
                  onClick={() => cancel.mutate()}
                >
                  取消赛段
                </Button>
              ) : null}
            </details>
          ) : null}
        </>
      )}

      {error === null || error === undefined ? null : (
        <p className="ui-field__error" role="alert">{errorMessage(error)}</p>
      )}
    </Card>
  );
}
