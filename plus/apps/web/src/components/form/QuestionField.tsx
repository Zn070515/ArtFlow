import type { RegistrationQuestion } from "../../api/registrations.js";
import { Textarea } from "../ui/Textarea.js";

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
      <div className="question question-notice question-full-row">
        <p>{question.label}</p>
      </div>
    );
  }
  return (
    <Textarea
      className="question-field question-full-row"
      label={<>{question.label}{question.required ? <em className="required-mark"> *</em> : null}</>}
      id={`question-${question.key}`}
      name={question.key}
      rows={2}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}
