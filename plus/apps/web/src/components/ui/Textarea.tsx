import { useId, type ReactNode, type TextareaHTMLAttributes } from "react";

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  readonly label: ReactNode;
  readonly error?: string;
}

export function Textarea({ label, error, id, className, ...rest }: TextareaProps) {
  const generatedId = useId();
  const textareaId = id ?? generatedId;
  const errorId = error === undefined ? undefined : `${textareaId}-error`;

  return (
    <div className={["ui-field", error === undefined ? "" : "ui-field--error", className].filter(Boolean).join(" ")}>
      <label className="ui-field__label" htmlFor={textareaId}>{label}</label>
      <textarea
        id={textareaId}
        className="ui-textarea"
        aria-invalid={error === undefined ? undefined : true}
        aria-describedby={errorId}
        {...rest}
      />
      {error === undefined ? null : <p id={errorId} className="ui-field__error" role="alert">{error}</p>}
    </div>
  );
}
