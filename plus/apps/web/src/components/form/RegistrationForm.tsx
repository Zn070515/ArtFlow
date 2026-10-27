import { useEffect, useRef, useState } from "react";

import { ApiError } from "../../api/client.js";
import {
  saveAnswer,
  submitRegistration,
  uploadMaterialContent,
  uploadMaterialMetadata,
  type RegistrationDetail,
} from "../../api/registrations.js";
import { FileMetadataField } from "./FileMetadataField.js";
import { QuestionField } from "./QuestionField.js";

const STATUS_LABELS: Readonly<Record<string, string>> = {
  draft: "草稿",
  submitted: "已提交",
  approved: "已通过",
  need_supplement: "需补充",
  rejected: "未通过",
};

function initialAnswers(detail: RegistrationDetail): Record<string, string> {
  const values: Record<string, string> = {};
  for (const question of detail.questionnaire.questions) {
    if (question.type !== "text") continue;
    const value = detail.registration.answers[question.key];
    values[question.key] = typeof value === "string" ? value : "";
  }
  return values;
}

function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "STALE_REVISION") return "数据已更新，请刷新页面后重试";
    return error.message;
  }
  return "网络或服务暂时不可用，请稍后重试";
}

export function RegistrationForm({
  detail,
  onChanged,
}: {
  readonly detail: RegistrationDetail;
  readonly onChanged: () => void;
}) {
  const editable =
    detail.registration.status === "draft" || detail.registration.status === "need_supplement";
  const [answers, setAnswers] = useState<Record<string, string>>(() => initialAnswers(detail));
  const [revision, setRevision] = useState(detail.registration.revision);
  const [busy, setBusy] = useState(false);
  const [fileBusy, setFileBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lastId = useRef(detail.registration.id);

  useEffect(() => {
    setRevision(detail.registration.revision);
    if (lastId.current !== detail.registration.id) {
      lastId.current = detail.registration.id;
      setAnswers(initialAnswers(detail));
    }
  }, [detail]);

  async function save(): Promise<number | null> {
    setBusy(true);
    setError(null);
    setMessage(null);
    let current = revision;
    try {
      for (const question of detail.questionnaire.questions) {
        if (question.type !== "text") continue;
        const value = answers[question.key] ?? "";
        const raw = detail.registration.answers[question.key];
        const serverValue = typeof raw === "string" ? raw : "";
        if (value === serverValue) continue;
        const saved = await saveAnswer(
          detail.activity.id,
          detail.registration.id,
          crypto.randomUUID(),
          current,
          question.key,
          value,
        );
        current = saved.revision;
        setRevision(current);
      }
      setMessage("草稿已保存");
      onChanged();
      return current;
    } catch (caught) {
      setError(messageFor(caught));
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function submit(): Promise<void> {
    const current = await save();
    if (current === null) return;
    setBusy(true);
    setError(null);
    try {
      await submitRegistration(
        detail.activity.id,
        detail.registration.id,
        crypto.randomUUID(),
        current,
      );
      setMessage("报名已提交");
      onChanged();
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(false);
    }
  }

  async function upload(questionKey: string, file: File): Promise<void> {
    setFileBusy(questionKey);
    setError(null);
    try {
      const material = await uploadMaterialMetadata(
        detail.activity.id,
        detail.registration.id,
        crypto.randomUUID(),
        {
          questionKey,
          originalName: file.name,
          contentType: file.type || "application/octet-stream",
          byteLength: file.size,
        },
      );
      // Metadata is only a staging row; the bytes must land before the slot
      // becomes current. A failed content write leaves the old file untouched.
      await uploadMaterialContent(
        detail.activity.id,
        material.id,
        crypto.randomUUID(),
        file,
      );
      setMessage("材料已上传");
      onChanged();
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setFileBusy(null);
    }
  }

  return (
    <section className="registration-panel">
      <div className="registration-head">
        <div>
          <p className="eyebrow">REGISTRATION · 报名</p>
          <h1 className="display results-title">{detail.activity.title}</h1>
        </div>
        <span className={`status-badge status-${detail.registration.status}`}>
          {STATUS_LABELS[detail.registration.status] ?? detail.registration.status}
        </span>
      </div>
      {detail.registration.reviewNote === undefined ? null : (
        <p className="review-note">审核意见：{detail.registration.reviewNote}</p>
      )}
      <div className="question-list">
        {detail.questionnaire.questions.map((question) => {
          if (question.type === "file") {
            return (
              <FileMetadataField
                key={question.key}
                question={question}
                material={detail.materials.find((material) => material.questionKey === question.key)}
                disabled={!editable}
                busy={fileBusy === question.key}
                onFile={(file) => {
                  void upload(question.key, file);
                }}
              />
            );
          }
          return (
            <QuestionField
              key={question.key}
              question={question}
              value={answers[question.key] ?? ""}
              disabled={!editable || busy}
              onChange={(value) => setAnswers((current) => ({ ...current, [question.key]: value }))}
            />
          );
        })}
      </div>
      {message === null ? null : <p className="form-success">{message}</p>}
      {error === null ? null : (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {editable ? (
        <div className="form-actions">
          <button className="secondary-button" type="button" disabled={busy} onClick={() => void save()}>
            保存草稿
          </button>
          <button className="primary-button" type="button" disabled={busy} onClick={() => void submit()}>
            提交报名
          </button>
        </div>
      ) : (
        <p className="auth-loading">报名已锁定，不能继续编辑。</p>
      )}
    </section>
  );
}
