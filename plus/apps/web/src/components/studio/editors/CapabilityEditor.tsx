import type { ComponentType } from "react";

import { capabilityLabel } from "../../format/labels.js";
import { CompetitionEditor } from "./CompetitionEditor.js";
import { MaterialsEditor } from "./MaterialsEditor.js";
import { PublishingEditor } from "./PublishingEditor.js";
import { QuestionnaireEditor } from "./QuestionnaireEditor.js";
import { ScheduleEditor } from "./ScheduleEditor.js";
import { RegistrationEditor } from "./RegistrationEditor.js";
import type { CapabilityEditorProps } from "./types.js";
import { VotingEditor } from "./VotingEditor.js";

const EDITORS: Readonly<Record<string, ComponentType<CapabilityEditorProps>>> = {
  registration: RegistrationEditor,
  questionnaire: QuestionnaireEditor,
  materials: MaterialsEditor,
  competition: CompetitionEditor,
  publishing: PublishingEditor,
  voting: VotingEditor,
  schedule: ScheduleEditor,
};

export function CapabilityEditor({
  capability,
  payload,
  onChange,
}: {
  readonly capability: string;
  readonly payload: unknown;
  readonly onChange: (next: unknown) => void;
}) {
  const Editor = EDITORS[capability];
  return (
    <section className="capability-editor" data-testid={`capability-editor-${capability}`}>
      <h3 className="ui-card__title">{capabilityLabel(capability)}</h3>
      {Editor === undefined ? (
        <p className="ui-card__description">
          该能力暂不支持结构化编辑，请使用“高级 JSON”修改它的定义。
        </p>
      ) : (
        <Editor payload={payload} onChange={onChange} />
      )}
    </section>
  );
}
