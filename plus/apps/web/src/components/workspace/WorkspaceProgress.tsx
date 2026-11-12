import type { WorkspaceProgressItem } from "./workspaceState.js";

const stateLabel: Readonly<Record<WorkspaceProgressItem["state"], string>> = {
  complete: "已完成",
  attention: "需要处理",
  available: "可继续",
  unavailable: "不可用",
};

export function WorkspaceProgress({ items }: { readonly items: readonly WorkspaceProgressItem[] }) {
  return (
    <section className="ops-card workspace-progress" aria-labelledby="workspace-progress-title">
      <p className="eyebrow">FLOW · 活动流程</p>
      <h2 className="console-card-title" id="workspace-progress-title">
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
            <span className="status-badge">{stateLabel[item.state]}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
