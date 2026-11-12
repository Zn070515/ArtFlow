import { useId, type SelectHTMLAttributes, type ReactNode } from "react";

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  readonly label: string;
  readonly children: ReactNode;
}

export function Select({ label, children, id, className, ...rest }: SelectProps) {
  const generatedId = useId();
  const selectId = id ?? generatedId;

  return (
    <div className={["ui-field", className].filter(Boolean).join(" ")}>
      <label className="ui-field__label" htmlFor={selectId}>{label}</label>
      <select id={selectId} className="ui-select" {...rest}>
        {children}
      </select>
    </div>
  );
}
