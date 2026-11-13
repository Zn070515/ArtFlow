import { useMutation } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { ApiError } from "../../api/client.js";
import type { PublicationView } from "../../api/voting.js";
import { editPublication } from "../../api/voting.js";
import { Button } from "../ui/Button.js";
import { Card } from "../ui/Card.js";
import { Input } from "../ui/Input.js";
import { Textarea } from "../ui/Textarea.js";

function humanError(error: unknown): string {
  if (error instanceof ApiError && error.status === 409) {
    return "公示内容已被更新，请刷新后重试。";
  }
  return error instanceof Error ? error.message : "公示编辑失败，请稍后重试。";
}

export function PublicationEditor({
  activityId,
  stageKey,
  publication,
  canManage,
  scope,
  onSaved,
}: {
  readonly activityId: string;
  readonly stageKey: string;
  readonly publication: PublicationView | undefined;
  readonly canManage: boolean;
  readonly scope: string;
  readonly onSaved: () => void;
}) {
  const [title, setTitle] = useState(publication?.title ?? "");
  const [content, setContent] = useState(publication?.content ?? "");
  useEffect(() => {
    setTitle(publication?.title ?? "");
    setContent(publication?.content ?? "");
  }, [publication?.id, publication?.version, publication?.title, publication?.content]);

  const mutation = useMutation({
    mutationFn: () =>
      editPublication(activityId, stageKey, {
        scope,
        expectedVersion: publication?.version ?? 0,
        title: title.trim(),
        content,
      }),
    onSuccess: onSaved,
  });

  return (
    <Card className="publication-editor" data-testid="publication-editor">
      <h3 className="ui-card__title">公示内容</h3>
      <p className="ui-card__description">
        {publication === undefined
          ? "尚未创建公示草稿。"
          : `当前版本 ${publication.version}；发布赛果后公示会被冻结。`}
      </p>
      {canManage ? (
        <>
          <Input label="标题" value={title} onChange={(event) => setTitle(event.target.value)} />
          <Textarea
            label="正文"
            rows={4}
            value={content}
            onChange={(event) => setContent(event.target.value)}
          />
          <Button
            variant="secondary"
            disabled={mutation.isPending || title.trim() === ""}
            onClick={() => mutation.mutate()}
          >
            保存公示
          </Button>
        </>
      ) : null}
      {mutation.error === null || mutation.error === undefined ? null : (
        <p className="ui-field__error" role="alert">{humanError(mutation.error)}</p>
      )}
    </Card>
  );
}
