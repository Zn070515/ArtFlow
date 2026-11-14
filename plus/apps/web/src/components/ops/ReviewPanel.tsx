import { useMutation } from "@tanstack/react-query";
import { useState } from "react";

import type { ReviewStatus } from "../../api/ops.js";
import { reviewRegistration } from "../../api/ops.js";
import type { RegistrationDetail } from "../../api/registrations.js";
import { label, REGISTRATION_STATUS_LABELS } from "../format/labels.js";
import { Button } from "../ui/Button.js";
import { Card } from "../ui/Card.js";
import { ConfirmDialog } from "../ui/Dialog.js";
import { Textarea } from "../ui/Textarea.js";

export function ReviewPanel({
  detail,
  onReviewed,
}: {
  readonly detail: RegistrationDetail;
  readonly onReviewed: () => void;
}) {
  const [note, setNote] = useState(detail.registration.reviewNote ?? "");
  const [rejectOpen, setRejectOpen] = useState(false);
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
              onClick={() => setRejectOpen(true)}
            >
              拒绝
            </Button>
          </div>
        </>
      ) : (
        <p className="ui-card__description">
          当前状态「{label(REGISTRATION_STATUS_LABELS, detail.registration.status)}」不可审核。
        </p>
      )}
      {mutation.error === null ? null : (
        <p className="ui-field__error" role="alert">
          {mutation.error instanceof Error ? mutation.error.message : "审核失败，请稍后重试"}
        </p>
      )}
      <ConfirmDialog
        open={rejectOpen}
        title="确认拒绝这份报名？"
        description="拒绝后参与者不能继续编辑；如需恢复，需要重新打开报名。审核意见会一并记录。"
        confirmLabel="确认拒绝"
        danger
        onCancel={() => setRejectOpen(false)}
        onConfirm={() => {
          setRejectOpen(false);
          mutation.mutate("rejected");
        }}
      />
    </Card>
  );
}
