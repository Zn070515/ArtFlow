import { Button } from "../../ui/Button.js";
import { Input } from "../../ui/Input.js";
import { isRecord, payloadRecord, records, text, type CapabilityEditorProps } from "./types.js";

function stageRecord(index: number): Record<string, unknown> {
  return { key: `stage-${index + 1}`, label: `阶段 ${index + 1}` };
}

export function PublishingEditor({ payload, onChange }: CapabilityEditorProps) {
  const record = payloadRecord(payload);
  const stages = records(record.stages);

  function update(next: Record<string, unknown>[]): void {
    onChange({
      ...record,
      version: 1,
      schemaVersion: 1,
      stages: next,
    });
  }

  return (
    <div className="editor-list">
      <p className="ui-card__description">发布阶段决定结果按哪些阶段确认和公开。</p>
      {stages.map((stage, index) => (
        <div className="editor-row" key={index}>
          <Input
            label={`阶段 ${index + 1} key`}
            value={text(stage.key)}
            onChange={(event) => {
              const next = [...stages];
              next[index] = { ...stage, key: event.target.value };
              update(next);
            }}
          />
          <Input
            label={`阶段 ${index + 1} 名称`}
            value={text(stage.label)}
            onChange={(event) => {
              const next = [...stages];
              next[index] = { ...stage, label: event.target.value };
              update(next);
            }}
          />
          <Button
            variant="secondary"
            size="sm"
            onClick={() => update(stages.filter((_, position) => position !== index))}
          >
            删除阶段
          </Button>
        </div>
      ))}
      <Button variant="secondary" size="sm" onClick={() => update([...stages, stageRecord(stages.length)])}>
        添加阶段
      </Button>
      {stages.length === 0 && isRecord(record) ? (
        <p className="ui-field__error" role="alert">至少需要一个发布阶段。</p>
      ) : null}
    </div>
  );
}
