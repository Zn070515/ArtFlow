import { Button } from "../../ui/Button.js";
import { Input } from "../../ui/Input.js";
import { Select } from "../../ui/Select.js";
import { integer, isRecord, payloadRecord, records, text, type CapabilityEditorProps } from "./types.js";

export function CompetitionEditor({ payload, onChange }: CapabilityEditorProps) {
  const record = payloadRecord(payload);
  const rounds = records(record.rounds);
  const rubric = isRecord(record.rubric) ? record.rubric : {};
  const criteria = records(rubric.criteria);

  function updateRounds(next: Record<string, unknown>[]): void {
    onChange({ ...record, rounds: next });
  }

  function updateCriteria(next: Record<string, unknown>[]): void {
    onChange({ ...record, rubric: { ...rubric, criteria: next } });
  }

  return (
    <div className="editor-list">
      <p className="ui-card__description">
        回合必须对应已有的 round 节点；新增/删除回合需要同时调整节点与边，请用高级 JSON。
      </p>
      {rounds.map((round, index) => (
        <div className="editor-row editor-row--stacked" key={index}>
          <div className="editor-row">
            <Input label={`回合 ${index + 1} key`} value={text(round.key)} readOnly />
            <Input
              label={`回合 ${index + 1} 评委人数`}
              type="number"
              min={1}
              value={String(integer(round.judgeCount, 1))}
              onChange={(event) => {
                const next = [...rounds];
                next[index] = { ...round, judgeCount: Number(event.target.value) };
                updateRounds(next);
              }}
            />
            <Input
              label={`回合 ${index + 1} 最少有效评委`}
              type="number"
              min={1}
              value={String(integer(round.minimumJudges, 1))}
              onChange={(event) => {
                const next = [...rounds];
                next[index] = { ...round, minimumJudges: Number(event.target.value) };
                updateRounds(next);
              }}
            />
            <Input
              label={`回合 ${index + 1} 晋级人数`}
              type="number"
              min={0}
              value={String(integer(round.advanceCount, 0))}
              onChange={(event) => {
                const next = [...rounds];
                next[index] = { ...round, advanceCount: Number(event.target.value) };
                updateRounds(next);
              }}
            />
          </div>
          <div className="editor-row">
            <Select
              label={`回合 ${index + 1} 完成规则`}
              value={text(round.completion, "minimum_valid")}
              onChange={(event) => {
                const next = [...rounds];
                next[index] = { ...round, completion: event.target.value };
                updateRounds(next);
              }}
            >
              <option value="minimum_valid">达到最少评委即可</option>
              <option value="full_matrix">必须全部评委提交</option>
            </Select>
            <Select
              label={`回合 ${index + 1} 计分方式`}
              value={text(round.scoringMethod, "average")}
              onChange={(event) => {
                const next = [...rounds];
                next[index] = { ...round, scoringMethod: event.target.value };
                updateRounds(next);
              }}
            >
              <option value="average">平均分</option>
              <option value="drop_high_low">去掉最高最低分</option>
            </Select>
          </div>
        </div>
      ))}
      <h3 className="ui-card__title">评分项</h3>
      {criteria.map((criterion, index) => (
        <div className="editor-row" key={index}>
          <Input
            label={`评分项 ${index + 1} key`}
            value={text(criterion.key)}
            onChange={(event) => {
              const next = [...criteria];
              next[index] = { ...criterion, key: event.target.value };
              updateCriteria(next);
            }}
          />
          <Input
            label={`评分项 ${index + 1} 权重`}
            type="number"
            min={0}
            step="0.01"
            value={String(criterion.weight ?? 1)}
            onChange={(event) => {
              const next = [...criteria];
              next[index] = { ...criterion, weight: Number(event.target.value) };
              updateCriteria(next);
            }}
          />
          <Input
            label={`评分项 ${index + 1} 最低分`}
            type="number"
            min={0}
            value={String(criterion.minimum ?? 0)}
            onChange={(event) => {
              const next = [...criteria];
              next[index] = { ...criterion, minimum: Number(event.target.value) };
              updateCriteria(next);
            }}
          />
          <Input
            label={`评分项 ${index + 1} 最高分`}
            type="number"
            min={1}
            value={String(criterion.maximum ?? 100)}
            onChange={(event) => {
              const next = [...criteria];
              next[index] = { ...criterion, maximum: Number(event.target.value) };
              updateCriteria(next);
            }}
          />
          <Button
            variant="secondary"
            size="sm"
            onClick={() => updateCriteria(criteria.filter((_, position) => position !== index))}
          >
            删除评分项
          </Button>
        </div>
      ))}
      <Button
        variant="secondary"
        size="sm"
        onClick={() =>
          updateCriteria([
            ...criteria,
            { key: `criterion-${criteria.length + 1}`, weight: 1, minimum: 0, maximum: 100 },
          ])
        }
      >
        添加评分项
      </Button>
      {record.tiePolicy === "review" ? (
        <p className="ui-card__description">同分策略：人工裁决（当前只支持这一种）。</p>
      ) : null}
    </div>
  );
}
