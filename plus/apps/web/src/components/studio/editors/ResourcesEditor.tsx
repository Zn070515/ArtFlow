import { Button } from "../../ui/Button.js";
import { Input } from "../../ui/Input.js";
import { payloadRecord, type CapabilityEditorProps } from "./types.js";

interface ResourceRow {
  readonly key: string;
  readonly name: string;
  readonly kind: "venue" | "equipment" | "staff";
  readonly capacity?: number;
  readonly notes: string;
}

function rows(payload: unknown): ResourceRow[] {
  const record = payloadRecord(payload);
  const raw = Array.isArray(record.resources) ? record.resources : [];
  return raw.flatMap((item) => {
    if (item === null || typeof item !== "object") return [];
    const value = item as Partial<ResourceRow>;
    if (typeof value.key !== "string" || typeof value.name !== "string") return [];
    return [{
      key: value.key,
      name: value.name,
      kind: value.kind === "equipment" || value.kind === "staff" ? value.kind : "venue",
      ...(typeof value.capacity === "number" ? { capacity: value.capacity } : {}),
      notes: typeof value.notes === "string" ? value.notes : "",
    }];
  });
}

export function ResourcesEditor({ payload, onChange }: CapabilityEditorProps) {
  const resources = rows(payload);
  const update = (next: readonly ResourceRow[]): void => {
    onChange({ schemaVersion: 1, resources: next });
  };

  return (
    <div className="editor-grid">
      <p className="ui-card__description">
        场地、设备或人员会在 release 中冻结；Ops 的预约只引用这些 key。
      </p>
      {resources.map((resource, index) => (
        <div className="editor-row" key={`resource-${index}`}>
          <Input
            label="Key"
            value={resource.key}
            onChange={(event) => {
              const next = [...resources];
              next[index] = { ...resource, key: event.target.value };
              update(next);
            }}
            maxLength={80}
          />
          <Input
            label="名称"
            value={resource.name}
            onChange={(event) => {
              const next = [...resources];
              next[index] = { ...resource, name: event.target.value };
              update(next);
            }}
            maxLength={120}
          />
          <label className="ui-field">
            <span className="ui-field__label">类型</span>
            <select
              className="ui-input"
              value={resource.kind}
              onChange={(event) => {
                const next = [...resources];
                next[index] = { ...resource, kind: event.target.value as ResourceRow["kind"] };
                update(next);
              }}
            >
              <option value="venue">场地</option>
              <option value="equipment">设备</option>
              <option value="staff">人员</option>
            </select>
          </label>
          <Input
            label="容量"
            type="number"
            min={1}
            value={resource.capacity === undefined ? "" : String(resource.capacity)}
            onChange={(event) => {
              const next = [...resources];
              const capacity = Number(event.target.value);
              next[index] = Number.isInteger(capacity) && capacity > 0
                ? { ...resource, capacity }
                : { key: resource.key, name: resource.name, kind: resource.kind, notes: resource.notes };
              update(next);
            }}
          />
          <Input
            label="资源说明"
            value={resource.notes}
            onChange={(event) => {
              const next = [...resources];
              next[index] = { ...resource, notes: event.target.value };
              update(next);
            }}
            maxLength={500}
          />
          <Button
            variant="secondary"
            size="sm"
            onClick={() => update(resources.filter((_, position) => position !== index))}
          >
            删除
          </Button>
        </div>
      ))}
      <Button
        variant="secondary"
        onClick={() => update([...resources, { key: "", name: "", kind: "venue", notes: "" }])}
      >
        添加资源
      </Button>
    </div>
  );
}
