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
    <div className="question question-file">
      <p className="question-label">
        {question.label}
        {question.required ? <em className="required-mark"> *</em> : null}
      </p>
      <input
        type="file"
        accept={question.file?.accepts.join(",")}
        disabled={disabled || busy}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file !== undefined) onFile(file);
          event.target.value = "";
        }}
      />
      {material === undefined ? null : (
        <p className="file-meta">
          已登记：{material.originalName} · {formatBytes(material.byteLength)}
        </p>
      )}
      <p className="file-warning">仅登记文件信息；字节存储将在媒体切片开放。</p>
    </div>
  );
}
