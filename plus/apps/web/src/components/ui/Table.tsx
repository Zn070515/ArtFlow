import { useId, type ReactNode } from "react";

export function Table({ caption, children, className }: {
  readonly caption: string;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  const captionId = useId();
  return (
    <div className="ui-table-wrap" role="region" aria-labelledby={captionId} tabIndex={0}>
      <table className={["ui-table", className].filter(Boolean).join(" ")}>
        <caption id={captionId} className="sr-only">{caption}</caption>
        {children}
      </table>
    </div>
  );
}
