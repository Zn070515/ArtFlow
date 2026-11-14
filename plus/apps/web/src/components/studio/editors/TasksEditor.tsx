import { Button } from "../../ui/Button.js";
import { Input } from "../../ui/Input.js";
import { payloadRecord, records, text, type CapabilityEditorProps } from "./types.js";

export function TasksEditor({ payload, onChange }: CapabilityEditorProps) {
  const record = payloadRecord(payload);
  const templates = records(record.templates);

  function update(next: Record<string, unknown>[]): void {
    onChange({ ...record, schemaVersion: 1, templates: next });
  }

  function updateTemplate(index: number, patch: Record<string, unknown>): void {
    const next = [...templates];
    next[index] = { ...templates[index], ...patch };
    update(next);
  }

  return (
    <div className="editor-list">
      <p className="ui-card__description">
        任务模板由能力事件生成；来源能力与来源 key 指向触发它的能力事实。
      </p>
      {templates.map((template, index) => (
        <div className="editor-row" key={index}>
          <Input
            label={`模板 ${index + 1} key`}
            value={text(template.key)}
            onChange={(event) => updateTemplate(index, { key: event.target.value })}
          />
          <Input
            label={`模板 ${index + 1} 标题`}
            value={text(template.title)}
            onChange={(event) => updateTemplate(index, { title: event.target.value })}
          />
          <Input
            label={`模板 ${index + 1} 来源能力`}
            value={text(template.sourceCapability)}
            onChange={(event) => updateTemplate(index, { sourceCapability: event.target.value })}
          />
          <Input
            label={`模板 ${index + 1} 来源 key`}
            value={text(template.sourceKey)}
            onChange={(event) => updateTemplate(index, { sourceKey: event.target.value })}
          />
          <label className="ui-field__label">
            <input
              type="checkbox"
              checked={template.required === true}
              onChange={(event) => updateTemplate(index, { required: event.target.checked })}
            />{" "}
            必需
          </label>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => update(templates.filter((_, position) => position !== index))}
          >
            删除模板
          </Button>
        </div>
      ))}
      <Button
        variant="secondary"
        size="sm"
        onClick={() =>
          update([
            ...templates,
            {
              key: `task-${templates.length + 1}`,
              title: "新任务",
              sourceCapability: "",
              sourceKey: "",
              required: true,
            },
          ])
        }
      >
        添加模板
      </Button>
    </div>
  );
}
