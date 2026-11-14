import { Button } from "../../ui/Button.js";
import { Input } from "../../ui/Input.js";
import { Select } from "../../ui/Select.js";
import { integer, payloadRecord, records, text, type CapabilityEditorProps } from "./types.js";

export function ScheduleEditor({ payload, onChange }: CapabilityEditorProps) {
  const record = payloadRecord(payload);
  const version = text(record.version, "v1");
  const slots = records(record.slots);

  function update(next: Record<string, unknown>[], nextVersion = version): void {
    onChange({ ...record, schemaVersion: 1, version: nextVersion, slots: next });
  }

  function updateSlot(index: number, patch: Record<string, unknown>): void {
    const next = [...slots];
    next[index] = { ...slots[index], ...patch };
    update(next);
  }

  return (
    <div className="editor-list">
      <Input label="排期版本" value={version} onChange={(event) => update(slots, event.target.value)} />
      <p className="ui-card__description">
        槽位定义节目类型和预计时长；实际节目条目在 Ops 的“节目排期”里添加。
      </p>
      {slots.map((slot, index) => (
        <div className="editor-row" key={index}>
          <Input
            label={`槽位 ${index + 1} key`}
            value={text(slot.key)}
            onChange={(event) => updateSlot(index, { key: event.target.value })}
          />
          <Input
            label={`槽位 ${index + 1} 名称`}
            value={text(slot.label)}
            onChange={(event) => updateSlot(index, { label: event.target.value })}
          />
          <Input
            label={`槽位 ${index + 1} 时长（分钟）`}
            type="number"
            min={1}
            max={1440}
            value={String(integer(slot.durationMinutes, 5))}
            onChange={(event) => updateSlot(index, { durationMinutes: Number(event.target.value) })}
          />
          <Select
            label={`槽位 ${index + 1} 类型`}
            value={text(slot.kind, "program")}
            onChange={(event) => updateSlot(index, { kind: event.target.value })}
          >
            <option value="program">节目</option>
            <option value="break">休息</option>
            <option value="ceremony">仪式</option>
          </Select>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => update(slots.filter((_, position) => position !== index))}
          >
            删除槽位
          </Button>
        </div>
      ))}
      <Button
        variant="secondary"
        size="sm"
        onClick={() =>
          update([
            ...slots,
            { key: `slot-${slots.length + 1}`, label: "新槽位", durationMinutes: 5, kind: "program" },
          ])
        }
      >
        添加槽位
      </Button>
    </div>
  );
}
