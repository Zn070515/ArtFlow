import type { ReactNode } from "react";

export function EmptyState({ title, description, action }: {
  readonly title: string;
  readonly description?: string;
  readonly action?: ReactNode;
}) {
  return (
    <section className="ui-state">
      <h2 className="ui-state__title">{title}</h2>
      {description === undefined ? null : <p className="ui-state__copy">{description}</p>}
      {action === undefined ? null : <div className="ui-state__action">{action}</div>}
    </section>
  );
}
