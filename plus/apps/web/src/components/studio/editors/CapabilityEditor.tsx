import type { ComponentType } from "react";

import { capabilityLabel } from "../../format/labels.js";
import { CompetitionEditor } from "./CompetitionEditor.js";
import { GroupingEditor } from "./GroupingEditor.js";
import { MaterialsEditor } from "./MaterialsEditor.js";
import { PublishingEditor } from "./PublishingEditor.js";
import { QuestionnaireEditor } from "./QuestionnaireEditor.js";
import { ScheduleEditor } from "./ScheduleEditor.js";
import { RegistrationEditor } from "./RegistrationEditor.js";
import { TasksEditor } from "./TasksEditor.js";
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
  grouping: GroupingEditor,
  tasks: TasksEditor,
};

/**
 * Capabilities whose definition carries no organizer-editable field. Their
 * runtime configuration lives in Ops (points, tickets, categories), so the
 * Studio tab explains that instead of sending the user to raw JSON.
 */
const CONFIGLESS: ReadonlySet<string> = new Set([
  "archive",
  "attendance",
  "incident",
  "ticketing",
]);

/** The ratchet used by CapabilityEditor.test.tsx: every registered capability
 * must be either structured or deliberately configless. */
export const CAPABILITY_EDITING: Readonly<Record<string, "structured" | "configless">> = {
  ...Object.fromEntries(Object.keys(EDITORS).map((key) => [key, "structured"] as const)),
  ...Object.fromEntries([...CONFIGLESS].map((key) => [key, "configless"] as const)),
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
      {Editor !== undefined ? (
        <Editor payload={payload} onChange={onChange} />
      ) : CONFIGLESS.has(capability) ? (
        <p className="ui-card__description">
          该能力没有可配置的定义项；签到点、票据、事故分类等运行配置在 Ops 中完成。
        </p>
      ) : (
        <p className="ui-card__description">
          此能力尚未声明结构化编辑方式。请使用“高级 JSON”，并先确认它的字段契约。
        </p>
      )}
    </section>
  );
}
