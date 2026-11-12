import type { ReactNode } from "react";

export function Card({ children, className }: {
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return <section className={["ui-card", className].filter(Boolean).join(" ")}>{children}</section>;
}

export function CardHeader({ title, description, actions }: {
  readonly title: string;
  readonly description?: string;
  readonly actions?: ReactNode;
}) {
  return (
    <header className="ui-card__header">
      <div>
        <h2 className="ui-card__title">{title}</h2>
        {description === undefined ? null : <p className="ui-card__description">{description}</p>}
      </div>
      {actions === undefined ? null : <div className="ui-card__actions">{actions}</div>}
    </header>
  );
}
