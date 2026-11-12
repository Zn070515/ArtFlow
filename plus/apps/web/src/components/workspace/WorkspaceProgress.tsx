import { Badge, type BadgeTone } from "../ui/Badge.js";
import { Card } from "../ui/Card.js";
import type { WorkspaceProgressItem } from "./workspaceState.js";

const stateLabel: Readonly<Record<WorkspaceProgressItem["state"], string>> = {
  complete: "已完成",
  attention: "需要处理",
  available: "可继续",
  unavailable: "不可用",
};

const stateTone: Readonly<Record<WorkspaceProgressItem["state"], BadgeTone>> = {
  complete: "success",
  attention: "warning",
  available: "neutral",
  unavailable: "neutral",
};

export function WorkspaceProgress({ items }: { readonly items: readonly WorkspaceProgressItem[] }) {
  return (
    <Card className="workspace-progress">
      <h2 className="ui-card__title" id="workspace-progress-title">
        活动进度
      </h2>
      <ol className="workspace-progress-list" aria-label="活动进度">
        {items.map((item) => (
          <li className={`workspace-progress-item is-${item.state}`} key={item.key}>
            <span className="workspace-progress-index" aria-hidden="true" />
            <div>
              <h3>{item.label}</h3>
              <p>{item.detail}</p>
            </div>
            <Badge tone={stateTone[item.state]}>{stateLabel[item.state]}</Badge>
          </li>
        ))}
      </ol>
    </Card>
  );
}
