import type { ReactNode } from "react";

export function Toolbar({ label, children, className }: {
  readonly label: string;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <div className={["ui-toolbar", className].filter(Boolean).join(" ")} role="search" aria-label={label}>
      {children}
    </div>
  );
}
