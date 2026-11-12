import { useMutation } from "@tanstack/react-query";
import { useState } from "react";

import type { ReviewStatus } from "../../api/ops.js";
import { reviewRegistration } from "../../api/ops.js";
import type { RegistrationDetail } from "../../api/registrations.js";
import { Button } from "../ui/Button.js";
import { Card } from "../ui/Card.js";
import { Textarea } from "../ui/Textarea.js";

const STATUS_LABELS: Readonly<Record<string, string>> = {
  draft: "草稿",
  submitted: "已提交",
  approved: "已通过",
  need_supplement: "需补充",
  rejected: "未通过",
};

export function ReviewPanel({
  detail,
  onReviewed,
}: {
  readonly detail: RegistrationDetail;
  readonly onReviewed: () => void;
}) {
  const [note, setNote] = useState(detail.registration.reviewNote ?? "");
  const mutation = useMutation({
    mutationFn: (status: ReviewStatus) =>
      reviewRegistration(
        detail.activity.id,
        detail.registration.id,
        crypto.randomUUID(),
        detail.registration.revision,
        status,
        note,
      ),
    onSuccess: () => {
      onReviewed();
    },
  });

  return (
    <Card className="review-panel">
      <h2 className="ui-card__title">审核报名</h2>
      {detail.registration.status === "submitted" ? (
        <>
          <Textarea
            label="审核意见"
            rows={3}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="可选；需补充时建议写明原因"
          />
          <div className="review-actions">
            <Button
              variant="primary"
              disabled={mutation.isPending}
              onClick={() => mutation.mutate("approved")}
            >
              批准
            </Button>
            <Button
              variant="secondary"
              disabled={mutation.isPending}
              onClick={() => mutation.mutate("need_supplement")}
            >
              需补充
            </Button>
            <Button
              variant="danger"
              disabled={mutation.isPending}
              onClick={() => mutation.mutate("rejected")}
            >
              拒绝
            </Button>
          </div>
        </>
      ) : (
        <p className="ui-card__description">
          当前状态「{STATUS_LABELS[detail.registration.status] ?? detail.registration.status}」不可审核。
        </p>
      )}
      {mutation.error === null ? null : (
        <p className="ui-field__error" role="alert">
          {mutation.error instanceof Error ? mutation.error.message : "审核失败，请稍后重试"}
        </p>
      )}
    </Card>
  );
}
