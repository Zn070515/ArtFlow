import { useId, type InputHTMLAttributes, type ReactNode } from "react";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  readonly label: ReactNode;
  readonly error?: string;
  readonly hint?: string;
}

export function Input({ label, error, hint, id, className, ...rest }: InputProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const hintId = hint === undefined ? undefined : `${inputId}-hint`;
  const errorId = error === undefined ? undefined : `${inputId}-error`;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;

  return (
    <div className={["ui-field", error === undefined ? "" : "ui-field--error", className].filter(Boolean).join(" ")}>
      <label className="ui-field__label" htmlFor={inputId}>{label}</label>
      <input
        id={inputId}
        className="ui-input"
        aria-invalid={error === undefined ? undefined : true}
        aria-describedby={describedBy}
        {...rest}
      />
      {hint === undefined ? null : <p id={hintId} className="ui-field__hint">{hint}</p>}
      {error === undefined ? null : <p id={errorId} className="ui-field__error" role="alert">{error}</p>}
    </div>
  );
}
