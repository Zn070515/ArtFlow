import { Input } from "../../ui/Input.js";
import { payloadRecord, type CapabilityEditorProps } from "./types.js";

interface TeamsDraft {
  readonly minSize: number;
  readonly maxSize: number;
  readonly requireCaptain: boolean;
  readonly source: "manual" | "grouping";
}

function draft(payload: unknown): TeamsDraft {
  const record = payloadRecord(payload);
  return {
    minSize: typeof record.minSize === "number" ? record.minSize : 1,
    maxSize: typeof record.maxSize === "number" ? record.maxSize : 8,
    requireCaptain: record.requireCaptain === true,
    source: record.source === "grouping" ? "grouping" : "manual",
  };
}

export function TeamsEditor({ payload, onChange }: CapabilityEditorProps) {
  const value = draft(payload);
  const update = (patch: Partial<TeamsDraft>): void => {
    onChange({ schemaVersion: 1, ...value, ...patch });
  };

  return (
    <div className="editor-grid">
      <p className="ui-card__description">
        队伍名册在 Ops 中维护；这里只决定人数范围、队长要求和来源。
      </p>
      <Input
        label="最少人数"
        type="number"
        min={1}
        max={64}
        value={String(value.minSize)}
        onChange={(event) => {
          const next = Number(event.target.value);
          if (Number.isInteger(next) && next >= 1 && next <= 64) update({ minSize: next });
        }}
      />
      <Input
        label="最多人数"
        type="number"
        min={1}
        max={64}
        value={String(value.maxSize)}
        onChange={(event) => {
          const next = Number(event.target.value);
          if (Number.isInteger(next) && next >= 1 && next <= 64) update({ maxSize: next });
        }}
      />
      <label className="ui-field">
        <span className="ui-field__label">队长</span>
        <select
          className="ui-input"
          value={value.requireCaptain ? "required" : "optional"}
          onChange={(event) => update({ requireCaptain: event.target.value === "required" })}
        >
          <option value="optional">不强制</option>
          <option value="required">每队必须一名</option>
        </select>
      </label>
      <label className="ui-field">
        <span className="ui-field__label">名册来源</span>
        <select
          className="ui-input"
          value={value.source}
          onChange={(event) => update({ source: event.target.value === "grouping" ? "grouping" : "manual" })}
        >
          <option value="manual">Ops 手工建队</option>
          <option value="grouping">从冻结分组导入</option>
        </select>
      </label>
    </div>
  );
}
