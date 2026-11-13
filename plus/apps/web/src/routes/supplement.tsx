import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import { useState } from "react";

import { ApiError } from "../api/client.js";
import {
  claimSupplement,
  fetchSupplementContext,
  submitSupplement,
  uploadSupplementMaterial,
} from "../api/supplement.js";
import { Button } from "../components/ui/Button.js";
import { Card } from "../components/ui/Card.js";

function errorMessage(error: unknown): string {
  const code = error instanceof ApiError ? error.code : "";
  if (code === "INVALID_SUPPLEMENT") return "补交链接无效、已被使用或已过期，请联系工作人员重新发送。";
  if (code === "ACTIVITY_NOT_ACTIVE") return "活动已结束，无法补交。";
  return error instanceof Error ? error.message : "补交失败，请稍后重试。";
}

export function SupplementPage() {
  const search = useSearch({ from: "/supplement" });
  const token = typeof search.token === "string" ? search.token : undefined;
  const queryClient = useQueryClient();
  const [files, setFiles] = useState<Readonly<Record<string, File>>>({});
  const [submitted, setSubmitted] = useState(false);
  const context = useQuery({
    queryKey: ["public-supplement", token ?? "cookie"],
    queryFn: () => (token === undefined ? fetchSupplementContext() : claimSupplement(token)),
    retry: false,
    staleTime: Infinity,
  });
  const upload = useMutation({
    mutationFn: ({ questionKey, file }: { readonly questionKey: string; readonly file: File }) =>
      uploadSupplementMaterial(questionKey, file),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["public-supplement"] });
    },
  });
  const submit = useMutation({
    mutationFn: submitSupplement,
    onSuccess: () => {
      // Submitting revokes the single-use grant. Refetching the claim here
      // would turn the confirmation into an "invalid link" error, so the
      // success state stays local.
      setSubmitted(true);
    },
  });

  if (context.isPending) return <p className="console-state auth-loading">正在加载补交信息…</p>;
  if (context.error !== null && context.error !== undefined) {
    return (
      <section className="console-state">
        <p className="eyebrow">SUPPLEMENT</p>
        <h1 className="console-page-title">无法打开补交</h1>
        <p className="state-copy" role="alert">{errorMessage(context.error)}</p>
      </section>
    );
  }

  const data = context.data;
  const allowed = new Set(data.allowedKeys);
  return (
    <main className="vote-page">
      <header className="vote-header">
        <p className="eyebrow">SUPPLEMENT · 补充材料</p>
        <h1 className="display">{data.activity.title}</h1>
        <p className="ui-state__copy">公开码 {data.activity.publicCode} · 当前状态 {data.status}</p>
      </header>
      <section className="vote-card" data-testid="supplement-page">
        {submitted ? (
          <p className="ui-state__copy" role="status">补交已提交，等待工作人员审核。</p>
        ) : (
          <>
            <p className="ui-state__copy">只开放以下材料槽位；其他答案不需要修改。</p>
            <ul className="vote-candidates">
              {data.checks.map((check) => {
                const material = data.materials.find((item) => item.questionKey === check.slotKey);
                const canUpload = allowed.has(check.slotKey);
                return (
                  <li key={check.slotKey} className="vote-candidate" data-testid="supplement-slot-row">
                    <strong>{check.itemName || check.slotKey}</strong>
                    <span className="ui-card__description">
                      {check.purpose} · 当前 {material === undefined ? "未提交" : material.originalName}
                      {check.reviewNote.trim() === "" ? "" : ` · 审核意见：${check.reviewNote}`}
                    </span>
                    {canUpload ? (
                      <>
                        <input
                          type="file"
                          aria-label={`上传 ${check.itemName || check.slotKey}`}
                          onChange={(event) => {
                            const file = event.target.files?.[0];
                            if (file === undefined) return;
                            setFiles({ ...files, [check.slotKey]: file });
                          }}
                        />
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={files[check.slotKey] === undefined || upload.isPending}
                          onClick={() => {
                            const file = files[check.slotKey];
                            if (file !== undefined) upload.mutate({ questionKey: check.slotKey, file });
                          }}
                        >
                          上传
                        </Button>
                      </>
                    ) : null}
                  </li>
                );
              })}
            </ul>
            <Button
              variant="primary"
              disabled={submit.isPending || data.allowedKeys.length === 0}
              onClick={() => submit.mutate()}
            >
              提交补交
            </Button>
            {upload.error === null || upload.error === undefined ? null : (
              <p className="ui-field__error" role="alert">{errorMessage(upload.error)}</p>
            )}
            {submit.error === null || submit.error === undefined ? null : (
              <p className="ui-field__error" role="alert">{errorMessage(submit.error)}</p>
            )}
          </>
        )}
      </section>
    </main>
  );
}
