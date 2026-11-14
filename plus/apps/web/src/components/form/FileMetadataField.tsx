import type { RegistrationMaterial, RegistrationQuestion } from "../../api/registrations.js";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function FileMetadataField({
  question,
  material,
  disabled,
  busy,
  onFile,
}: {
  readonly question: RegistrationQuestion;
  readonly material: RegistrationMaterial | undefined;
  readonly disabled: boolean;
  readonly busy: boolean;
  readonly onFile: (file: File) => void;
}) {
  return (
    <label className="field question question-file question-full-row">
      <span className="question-label">
        {question.label}
        {question.required ? <em className="required-mark"> *</em> : null}
      </span>
      {material === undefined ? (
        <input
          className="ui-input"
          id={`question-${question.key}`}
          name={question.key}
          type="file"
          accept={question.file?.accepts.join(",")}
          disabled={disabled || busy}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file !== undefined) onFile(file);
            event.target.value = "";
          }}
        />
      ) : (
        <input
          className="sr-only"
          id={`question-${question.key}`}
          name={question.key}
          type="file"
          accept={question.file?.accepts.join(",")}
          disabled={disabled || busy}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file !== undefined) onFile(file);
            event.target.value = "";
          }}
        />
      )}
      {material === undefined ? null : (
        <>
          <span className="ui-button ui-button--secondary ui-button--sm">
            {busy ? "正在上传…" : "重新选择文件"}
          </span>
          <p className={material.contentReady ? "file-meta" : "file-warning"}>
            {material.contentReady ? "已上传" : "字节尚未保存"}：{material.originalName} ·{" "}
            {formatBytes(material.byteLength)}
          </p>
        </>
      )}
    </label>
  );
}
