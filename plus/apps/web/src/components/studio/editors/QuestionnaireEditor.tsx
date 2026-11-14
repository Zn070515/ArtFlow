import { Button } from "../../ui/Button.js";
import { Input } from "../../ui/Input.js";
import { Select } from "../../ui/Select.js";
import { integer, isRecord, payloadRecord, records, text, type CapabilityEditorProps } from "./types.js";

export function QuestionnaireEditor({ payload, onChange }: CapabilityEditorProps) {
  const record = payloadRecord(payload);
  const version = text(record.version, "v1");
  const questions = records(record.questions);

  function update(next: Record<string, unknown>[], nextVersion = version): void {
    onChange({ ...record, schemaVersion: 1, version: nextVersion, questions: next });
  }

  function updateQuestion(index: number, patch: Record<string, unknown>): void {
    const next = [...questions];
    next[index] = { ...questions[index], ...patch };
    update(next);
  }

  const duplicateKeys = questions
    .map((question) => text(question.key))
    .filter((key, index, all) => key !== "" && all.indexOf(key) !== index);

  return (
    <div className="editor-list">
      <Input
        label="问卷版本"
        value={version}
        onChange={(event) => update(questions, event.target.value)}
      />
      <p className="ui-card__description">
        问题 key 在 release 内必须唯一；文件槽位决定参与者能上传哪些材料。
      </p>
      {questions.map((question, index) => {
        const type = text(question.type, "text");
        const file = isRecord(question.file) ? question.file : {};
        const accepts = Array.isArray(file.accepts)
          ? file.accepts.filter((item): item is string => typeof item === "string")
          : [];
        return (
          <div className="editor-row editor-row--stacked" key={index}>
            <div className="editor-row">
              <Input
                label={`问题 ${index + 1} key`}
                value={text(question.key)}
                onChange={(event) => updateQuestion(index, { key: event.target.value })}
              />
              <Input
                label={`问题 ${index + 1} 标题`}
                value={text(question.label)}
                onChange={(event) => updateQuestion(index, { label: event.target.value })}
              />
              <Select
                label={`问题 ${index + 1} 类型`}
                value={type}
                onChange={(event) => {
                  const nextType = event.target.value;
                  const patch: Record<string, unknown> = { type: nextType };
                  if (nextType === "file") {
                    patch.file = isRecord(question.file)
                      ? question.file
                      : { slot: text(question.key, `slot-${index + 1}`), purpose: text(question.key, "material"), accepts: [".pdf"] };
                  } else {
                    delete patch.file;
                    patch.file = undefined;
                  }
                  if (nextType === "notice") patch.required = false;
                  updateQuestion(index, patch);
                }}
              >
                <option value="text">文本</option>
                <option value="file">文件</option>
                <option value="notice">说明文字</option>
              </Select>
            </div>
            {type === "notice" ? null : (
              <label className="inline-check">
                <input
                  type="checkbox"
                  checked={question.required === true}
                  onChange={(event) => updateQuestion(index, { required: event.target.checked })}
                />
                必填
              </label>
            )}
            {type === "file" ? (
              <div className="editor-row">
                <Input
                  label="文件槽位"
                  value={text(file.slot)}
                  onChange={(event) => updateQuestion(index, { file: { ...file, slot: event.target.value } })}
                />
                <Input
                  label="用途"
                  value={text(file.purpose)}
                  onChange={(event) => updateQuestion(index, { file: { ...file, purpose: event.target.value } })}
                />
                <Input
                  label="允许扩展名（逗号分隔）"
                  value={accepts.join(", ")}
                  onChange={(event) =>
                    updateQuestion(index, {
                      file: {
                        ...file,
                        accepts: event.target.value.split(",").map((item) => item.trim()).filter(Boolean),
                      },
                    })
                  }
                />
                <Input
                  label="最大字节数（可选）"
                  type="number"
                  min={1}
                  value={file.maxBytes === undefined ? "" : String(file.maxBytes)}
                  onChange={(event) => {
                    const raw = event.target.value.trim();
                    const nextFile = { ...file };
                    if (raw === "") delete nextFile.maxBytes;
                    else nextFile.maxBytes = integer(Number(raw), 1);
                    updateQuestion(index, { file: nextFile });
                  }}
                />
              </div>
            ) : null}
            <Button
              variant="secondary"
              size="sm"
              onClick={() => update(questions.filter((_, position) => position !== index))}
            >
              删除问题
            </Button>
          </div>
        );
      })}
      <Button
        variant="secondary"
        size="sm"
        onClick={() =>
          update([
            ...questions,
            { key: `question-${questions.length + 1}`, label: "新问题", type: "text", required: false },
          ])
        }
      >
        添加问题
      </Button>
      {duplicateKeys.length === 0 ? null : (
        <p className="ui-field__error" role="alert">
          key 重复：{duplicateKeys.join("、")}
        </p>
      )}
    </div>
  );
}
