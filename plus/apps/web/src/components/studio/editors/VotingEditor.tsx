import { Input } from "../../ui/Input.js";
import { Select } from "../../ui/Select.js";
import { integer, isRecord, payloadRecord, text, type CapabilityEditorProps } from "./types.js";

export function VotingEditor({ payload, onChange }: CapabilityEditorProps) {
  const record = payloadRecord(payload);
  const purpose = text(record.purpose, "popularity");
  const selectionType = text(record.selectionType, "single");
  const maxSelections = integer(record.maxSelections, 1);
  const identityPolicy = text(record.identityPolicy, "browser");
  const scoringRule = isRecord(record.scoringRule) ? record.scoringRule : {};
  const scale = integer(scoringRule.scale, 100);
  const decimals = integer(scoringRule.decimals, 2);

  function update(patch: Record<string, unknown>): void {
    const nextSelection = text(patch.selectionType ?? selectionType);
    onChange({
      ...record,
      schemaVersion: 2,
      purpose: text(patch.purpose ?? purpose),
      selectionType: nextSelection,
      maxSelections: nextSelection === "single" ? 1 : Math.max(1, integer(patch.maxSelections ?? maxSelections, 1)),
      identityPolicy: text(patch.identityPolicy ?? identityPolicy),
      scoringRule: {
        ...scoringRule,
        kind: "ballot_share_percent",
        scale: integer(patch.scale ?? scale, 100),
        decimals: integer(patch.decimals ?? decimals, 2),
      },
      ...Object.fromEntries(
        Object.entries(patch).filter(([key]) => !["purpose", "selectionType", "maxSelections", "identityPolicy", "scale", "decimals"].includes(key)),
      ),
    });
  }

  return (
    <div className="editor-grid">
      <Select label="投票用途" value={purpose} onChange={(event) => update({ purpose: event.target.value })}>
        <option value="popularity">人气投票</option>
        <option value="score_component">计入比赛成绩</option>
      </Select>
      <Select
        label="选择方式"
        value={selectionType}
        onChange={(event) => update({ selectionType: event.target.value })}
      >
        <option value="single">单选</option>
        <option value="multi">多选</option>
      </Select>
      <Input
        label="最多可选数量"
        type="number"
        min={1}
        value={String(maxSelections)}
        disabled={selectionType === "single"}
        onChange={(event) => update({ maxSelections: Number(event.target.value) })}
      />
      <Select
        label="身份策略"
        value={identityPolicy}
        onChange={(event) => update({ identityPolicy: event.target.value })}
      >
        <option value="browser">浏览器身份</option>
        <option value="ticket">票据</option>
        <option value="anonymous">匿名</option>
      </Select>
      <Input
        label="百分比刻度"
        type="number"
        min={1}
        value={String(scale)}
        onChange={(event) => update({ scale: Number(event.target.value) })}
      />
      <Input
        label="小数位"
        type="number"
        min={0}
        value={String(decimals)}
        onChange={(event) => update({ decimals: Number(event.target.value) })}
      />
    </div>
  );
}
