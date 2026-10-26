import type { RegistrationQuestion } from "../../api/registrations.js";

export function QuestionField({
  question,
  value,
  onChange,
  disabled,
}: {
  readonly question: RegistrationQuestion;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly disabled: boolean;
}) {
  if (question.type === "notice") {
    return (
      <div className="question question-notice">
        <p>{question.label}</p>
      </div>
    );
  }
  return (
    <label className="field question-field">
      <span>
        {question.label}
        {question.required ? <em className="required-mark"> *</em> : null}
      </span>
      <textarea
        rows={2}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}
