import { useMutation } from "@tanstack/react-query";
import { useState } from "react";

import type { RegistrationDetail, RegistrationMaterial } from "../../api/registrations.js";
import { reviewMaterial } from "../../api/registrations.js";
import { Badge, type BadgeTone } from "../ui/Badge.js";
import { apiErrorText } from "../ui/apiError.js";
import { Button } from "../ui/Button.js";
import { Card } from "../ui/Card.js";
import { Input } from "../ui/Input.js";

const MATERIAL_TONES: Readonly<Record<string, BadgeTone>> = {
  submitted: "info",
  approved: "success",
  needs_supplement: "warning",
  rejected: "warning",
};

const MATERIAL_LABELS: Readonly<Record<string, string>> = {
  submitted: "待审核",
  approved: "已通过",
  needs_supplement: "需补充",
  rejected: "未通过",
};

export function MaterialsReviewPanel({
  detail,
  canManage,
  onReviewed,
}: {
  readonly detail: RegistrationDetail;
  readonly canManage: boolean;
  readonly onReviewed: () => void;
}) {
  const [note, setNote] = useState("");
  const mutation = useMutation({
    mutationFn: (input: { readonly material: RegistrationMaterial; readonly status: "approved" | "needs_supplement" }) =>
      reviewMaterial(
        detail.activity.id,
        detail.registration.id,
        input.material.id,
        crypto.randomUUID(),
        {
          expectedRevision: input.material.revision,
          status: input.status,
          note: note.trim(),
        },
      ),
    onSuccess: onReviewed,
  });

  if (detail.materials.length === 0) return null;
  return (
    <Card className="materials-review-panel" data-testid="materials-review-panel">
      <h2 className="ui-card__title">材料审核</h2>
      <ul className="seat-list">
        {detail.materials.map((material) => (
          <li key={material.id} data-testid="material-review-row" data-material-status={material.status}>
            <Badge tone={MATERIAL_TONES[material.status] ?? "neutral"}>
              {MATERIAL_LABELS[material.status] ?? material.status}
            </Badge>{" "}
            {material.originalName} · {material.questionKey}
            {material.contentReady ? null : <span className="ui-field__error"> · 字节未保存，不能通过</span>}
            {canManage ? (
              <div className="task-actions">
                <Button
                  variant="primary"
                  size="sm"
                  disabled={mutation.isPending || !material.contentReady}
                  onClick={() => mutation.mutate({ material, status: "approved" })}
                >
                  通过
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={mutation.isPending}
                  onClick={() => mutation.mutate({ material, status: "needs_supplement" })}
                >
                  需补充
                </Button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      {canManage ? (
        <Input
          label="材料审核意见"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="需补充时建议写明原因"
        />
      ) : null}
      {mutation.error === null || mutation.error === undefined ? null : (
        <p className="ui-field__error" role="alert">{apiErrorText(mutation.error, "材料审核失败，请稍后重试。", "材料已被更新，请刷新后重试。")}</p>
      )}
    </Card>
  );
}
