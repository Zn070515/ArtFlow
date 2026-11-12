import type { ReactNode } from "react";

export function Table({ caption, children, className }: {
  readonly caption: string;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <div className="ui-table-wrap">
      <table className={["ui-table", className].filter(Boolean).join(" ")}>
        <caption className="sr-only">{caption}</caption>
        {children}
      </table>
    </div>
  );
}
