import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { ApiError } from "../../api/client.js";
import { finalizeRoster, reopenRoster, type OpsRoster } from "../../api/ops.js";
import { Button } from "../ui/Button.js";
import { Card } from "../ui/Card.js";
import { Textarea } from "../ui/Textarea.js";

export interface RosterRegistrationSummary {
  readonly approved: number;
  readonly pending: number;
}

function pendingCountFrom(error: ApiError): number | null {
  if (typeof error.details !== "object" || error.details === null) return null;
  const pendingCount = (error.details as { pendingCount?: unknown }).pendingCount;
  return typeof pendingCount === "number" ? pendingCount : null;
}

function rosterErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return "操作失败，请稍后重试";
  if (error.code === "ROSTER_HAS_PENDING") {
    const pending = pendingCountFrom(error);
    return pending === null
      ? "还有报名待审核，先审核完再定稿。"
      : `还有 ${pending} 条报名待审核，先审核完再定稿。`;
  }
  if (error.code === "ROSTER_EMPTY") return "还没有已通过的报名，不能定稿空名单。";
  if (error.code === "ROSTER_FINAL") return "名单已定稿；如需修改，请先重新打开名单。";
  if (error.code === "STALE_REVISION") return "名单已被其他人更新，请刷新后重试。";
  return error.message;
}

/**
 * Roster finalization is a one-way freeze in the domain. The UI must therefore
 * (a) refuse to offer it while registrations are still loading or waiting for
 * review, (b) describe exactly what will be locked, and (c) keep a controlled
 * reopen path so a mistaken finalization is recoverable.
 */
export function RosterCard({
  activityId,
  roster,
  summary,
}: {
  readonly activityId: string;
  readonly roster: OpsRoster;
  /** `null` while the registration list is still loading or failed. */
  readonly summary: RosterRegistrationSummary | null;
}) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [reopening, setReopening] = useState(false);
  const [reason, setReason] = useState("");
  const finalize = useMutation({
    mutationFn: () => finalizeRoster(activityId, crypto.randomUUID(), roster.revision),
    onSuccess: (saved) => {
      setConfirming(false);
      queryClient.setQueryData(["ops-roster", activityId], saved);
      void queryClient.invalidateQueries({ queryKey: ["ops-registrations", activityId] });
    },
  });
  const reopen = useMutation({
    mutationFn: () =>
      reopenRoster(activityId, crypto.randomUUID(), roster.revision, reason.trim()),
    onSuccess: (saved) => {
      setReopening(false);
      setReason("");
      queryClient.setQueryData(["ops-roster", activityId], saved);
      void queryClient.invalidateQueries({ queryKey: ["ops-registrations", activityId] });
    },
  });

  const pending = summary?.pending ?? 0;
  const approved = summary?.approved ?? 0;
  const blockedReason =
    summary === null
      ? "正在读取最新报名，加载完成后才能定稿。"
      : pending > 0
        ? `还有 ${pending} 条报名待审核，先审核完再定稿。`
        : approved === 0
          ? "还没有已通过的报名，不能定稿空名单。"
          : null;
  const error = finalize.error ?? reopen.error;

  return (
    <Card>
      <h2 className="ui-card__title">名单状态</h2>
      {roster.status === "final" ? (
        <>
          <p className="ui-card__description">
            已定稿 · {roster.approvedCount} 人 ·{" "}
            {new Date(roster.finalizedAt).toLocaleString("zh-CN")}
          </p>
          <p className="ui-card__description">定稿后审核已冻结；确需修改时先重新打开名单。</p>
          {reopening ? (
            <div className="session-controls">
              <Textarea
                label="重新打开的原因"
                rows={2}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="例如：误把名单定稿成 0 人，需要重新审核报名"
              />
              <Button
                variant="primary"
                disabled={reopen.isPending || reason.trim().length === 0}
                onClick={() => reopen.mutate()}
              >
                {reopen.isPending ? "正在重新打开…" : "确认重新打开"}
              </Button>
              <Button
                variant="secondary"
                disabled={reopen.isPending}
                onClick={() => {
                  setReopening(false);
                  setReason("");
                }}
              >
                取消
              </Button>
            </div>
          ) : (
            <Button variant="secondary" onClick={() => setReopening(true)}>
              重新打开名单
            </Button>
          )}
        </>
      ) : confirming ? (
        <div className="session-controls">
          <p className="ui-card__description">
            将定稿 {approved} 名已通过者。定稿后审核会被冻结，未审核的报名必须先处理。
          </p>
          <Button variant="primary" disabled={finalize.isPending} onClick={() => finalize.mutate()}>
            {finalize.isPending ? "正在定稿…" : `确认定稿 ${approved} 人`}
          </Button>
          <Button variant="secondary" disabled={finalize.isPending} onClick={() => setConfirming(false)}>
            取消
          </Button>
        </div>
      ) : (
        <>
          <p className="ui-card__description">
            {summary === null
              ? "正在读取最新报名…"
              : `尚未定稿。已通过 ${approved} 人，待审核 ${pending} 人。`}
          </p>
          <Button
            variant="primary"
            disabled={blockedReason !== null}
            title={blockedReason ?? undefined}
            onClick={() => setConfirming(true)}
          >
            定稿名单
          </Button>
          {blockedReason === null ? null : <p className="ui-card__description">{blockedReason}</p>}
        </>
      )}
      {error === null ? null : (
        <p className="ui-field__error" role="alert">
          {rosterErrorMessage(error)}
        </p>
      )}
    </Card>
  );
}
