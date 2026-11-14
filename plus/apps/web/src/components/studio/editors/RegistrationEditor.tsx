import { Select } from "../../ui/Select.js";
import { payloadRecord, text, type CapabilityEditorProps } from "./types.js";

const LIFECYCLES = [
  { value: "draft", label: "草稿（不开放报名）" },
  { value: "open", label: "开放报名" },
  { value: "review", label: "审核中" },
  { value: "final", label: "已截止" },
] as const;

export function RegistrationEditor({ payload, onChange }: CapabilityEditorProps) {
  const record = payloadRecord(payload);
  const lifecycle = text(record.lifecycle, "open");

  return (
    <div className="editor-grid">
      <Select
        label="报名生命周期"
        value={lifecycle}
        onChange={(event) =>
          onChange({
            ...record,
            schemaVersion: 1,
            lifecycleVersion: 1,
            lifecycle: event.target.value,
          })
        }
      >
        {LIFECYCLES.map((item) => (
          <option key={item.value} value={item.value}>{item.label}</option>
        ))}
      </Select>
      <p className="ui-card__description">
        该状态会随定义编译进入 release，参与者只能按发布时的生命周期报名。
      </p>
    </div>
  );
}
