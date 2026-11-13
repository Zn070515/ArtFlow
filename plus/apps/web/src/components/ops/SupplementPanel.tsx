import { useMutation } from "@tanstack/react-query";
import { useState } from "react";

import type { IssuedSupplementView } from "../../api/ops.js";
import { issueSupplement } from "../../api/ops.js";
import type { RegistrationDetail } from "../../api/registrations.js";
import { apiErrorText } from "../ui/apiError.js";
import { Button } from "../ui/Button.js";
import { Card } from "../ui/Card.js";

export function SupplementPanel({
  detail,
  canManage,
  onIssued,
}: {
  readonly detail: RegistrationDetail;
  readonly canManage: boolean;
  readonly onIssued: () => void;
}) {
  const slots = detail.questionnaire.fileSlots;
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [issued, setIssued] = useState<IssuedSupplementView | undefined>();
  const mutation = useMutation({
    mutationFn: () =>
      issueSupplement(detail.activity.id, detail.registration.id, selected, crypto.randomUUID()),
    onSuccess: (result) => {
      setSelected([]);
      setIssued(result);
      onIssued();
    },
  });
  const supplementLink =
    issued?.token === null || issued?.token === undefined
      ? undefined
      : `${window.location.origin}/supplement?token=${encodeURIComponent(issued.token)}`;

  if (slots.length === 0) return null;
  return (
    <Card className="supplement-panel" data-testid="supplement-panel">
      <h2 className="ui-card__title">补交授权</h2>
      <p className="ui-card__description">
        选择允许参与者补交的材料槽位。授权后报名状态会变为「需补充」。
      </p>
      <fieldset className="supplement-slots">
        <legend className="ui-field__label">可补交槽位</legend>
        {slots.map((slot) => {
          const checked = selected.includes(slot.key);
          return (
            <label key={slot.key} className="supplement-slot">
              <input
                type="checkbox"
                checked={checked}
                onChange={(event) => {
                  setSelected(
                    event.target.checked
                      ? [...selected, slot.key]
                      : selected.filter((key) => key !== slot.key),
                  );
                }}
              />
              <span>{slot.purpose || slot.slot} · {slot.key}</span>
            </label>
          );
        })}
      </fieldset>
      {canManage ? (
        <Button
          variant="secondary"
          disabled={mutation.isPending || selected.length === 0}
          onClick={() => mutation.mutate()}
        >
          发出补交授权
        </Button>
      ) : null}
      {supplementLink === undefined ? null : (
        <p className="ui-card__description" role="status">
          补交链接（{new Date(issued!.expiresAt).toLocaleString("zh-CN")} 前有效）：{" "}
          <a className="table-link" href={supplementLink}>{supplementLink}</a>
        </p>
      )}
      {mutation.error === null || mutation.error === undefined ? null : (
        <p className="ui-field__error" role="alert">{apiErrorText(mutation.error, "补交授权失败，请稍后重试。", "报名已被更新，请刷新后重试。")}</p>
      )}
    </Card>
  );
}
