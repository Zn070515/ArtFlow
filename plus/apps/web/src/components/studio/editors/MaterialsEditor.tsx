import { Input } from "../../ui/Input.js";
import { Textarea } from "../../ui/Textarea.js";
import { integer, payloadRecord, type CapabilityEditorProps } from "./types.js";

export function MaterialsEditor({ payload, onChange }: CapabilityEditorProps) {
  const record = payloadRecord(payload);
  const maxBytes = integer(record.maxBytes, 25 * 1024 * 1024);
  const purposes = Array.isArray(record.allowedPurposes)
    ? record.allowedPurposes.filter((item): item is string => typeof item === "string")
    : [];

  function update(patch: Record<string, unknown>): void {
    onChange({ ...record, schemaVersion: 1, maxBytes, allowedPurposes: purposes, ...patch });
  }

  return (
    <div className="editor-grid">
      <Input
        label="单文件最大字节数"
        type="number"
        min={1}
        value={String(maxBytes)}
        onChange={(event) => {
          const next = Number(event.target.value);
          if (Number.isInteger(next) && next > 0) update({ maxBytes: next });
        }}
      />
      <p className="ui-card__description">
        当前上限约 {(maxBytes / (1024 * 1024)).toFixed(1)} MiB。
      </p>
      <Textarea
        label="允许的材料用途（每行一个）"
        rows={4}
        value={purposes.join("\n")}
        onChange={(event) =>
          update({
            allowedPurposes: event.target.value
              .split(/\r?\n/)
              .map((line) => line.trim())
              .filter(Boolean),
          })
        }
      />
    </div>
  );
}
