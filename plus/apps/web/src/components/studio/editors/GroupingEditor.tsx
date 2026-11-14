import { Input } from "../../ui/Input.js";
import { integer, payloadRecord, type CapabilityEditorProps } from "./types.js";

export function GroupingEditor({ payload, onChange }: CapabilityEditorProps) {
  const record = payloadRecord(payload);
  const groupCount = record.groupCount === undefined
    ? ""
    : String(integer(record.groupCount, 2));

  return (
    <div className="editor-grid">
      <Input
        label="默认分组数量（可选）"
        type="number"
        min={1}
        value={groupCount}
        onChange={(event) => {
          const raw = event.target.value.trim();
          if (raw === "") {
            const next: Record<string, unknown> = { ...record, schemaVersion: 1 };
            delete next.groupCount;
            onChange(next);
            return;
          }
          const next = Number(raw);
          if (Number.isInteger(next) && next > 0) {
            onChange({ ...record, schemaVersion: 1, groupCount: next });
          }
        }}
        hint="仅作为 Ops 创建分组时的默认值；实际成员与确认仍在 Ops 完成。"
      />
    </div>
  );
}
