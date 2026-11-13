import { useState } from "react";

import {
  describeLiveError,
  submitStaffScore,
  type LiveRound,
  type LiveState,
} from "../../api/live.js";
import { Button } from "../ui/Button.js";
import { Card } from "../ui/Card.js";
import { Input } from "../ui/Input.js";
import { Select } from "../ui/Select.js";

type StaffSource = "staff_rapid" | "staff_proxy" | "paper_dr";

const SOURCE_LABELS: Readonly<Record<StaffSource, string>> = {
  staff_rapid: "快速评分",
  staff_proxy: "工作人员代录",
  paper_dr: "纸面评分录入",
};

export function LiveStaffScorePanel({
  state,
  live,
  onChanged,
}: {
  readonly state: LiveState;
  readonly live: LiveRound;
  readonly onChanged: () => void;
}) {
  const criteria = state.config.rubric.criteria;
  const [seatId, setSeatId] = useState("");
  const [source, setSource] = useState<StaffSource>("staff_rapid");
  const [values, setValues] = useState<Readonly<Record<string, string>>>({});
  const [notes, setNotes] = useState("");
  const [sourceReference, setSourceReference] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const round = live.round;
  const panel = live.panel;
  const performance = live.performances.find((item) => item.state === "open");
  const seats = live.seats.filter((seat) => seat.state === "assigned");
  if (round === null || panel === null || performance === undefined) return null;

  async function submit(): Promise<void> {
    if (round === null || panel === null || performance === undefined) return;
    setBusy(true);
    setError(null);
    try {
      const parsed: Record<string, number> = {};
      for (const criterion of criteria) {
        const raw = values[criterion.key] ?? "";
        const value = Number(raw);
        if (raw.trim() === "" || !Number.isFinite(value)) {
          throw new Error(`请填写「${criterion.key}」。`);
        }
        if (value < (criterion.minimum ?? 0) || value > criterion.maximum) {
          throw new Error(`「${criterion.key}」需在 ${criterion.minimum ?? 0}–${criterion.maximum} 之间。`);
        }
        parsed[criterion.key] = value;
      }
      if (seatId === "") throw new Error("请选择评委席位。");
      if (source !== "staff_rapid" && (sourceReference.trim() === "" || reason.trim() === "")) {
        throw new Error("代录与纸面录入必须填写来源和说明。");
      }
      await submitStaffScore({
        activityId: state.activity.id,
        roundKey: live.config.key,
        performanceId: performance.id,
        panelSnapshotId: panel.id,
        seatId,
        contextVersion: performance.contextVersion,
        criteria: parsed,
        notes,
        source,
        ...(source === "staff_rapid" ? {} : { sourceReference: sourceReference.trim(), reason: reason.trim() }),
      });
      setValues({});
      setNotes("");
      setSourceReference("");
      setReason("");
      onChanged();
    } catch (caught) {
      setError(describeLiveError(caught, "评分补录失败。"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="live-staff-score-card" data-testid="live-staff-score-card">
      <h2 className="ui-card__title">现场评分补录</h2>
      <p className="ui-card__description">
        当前表演：{state.participantNames[performance.contestantId] ?? performance.contestantId} ·
        已收 {performance.scoreCount}/{performance.expectedJudges}
      </p>
      <div className="panel-form">
        <Select label="评委席位" value={seatId} onChange={(event) => setSeatId(event.target.value)}>
          <option value="">选择席位</option>
          {seats.map((seat) => (
            <option key={seat.id} value={seat.id}>
              {seat.seatKey} · {seat.judgeId}
            </option>
          ))}
        </Select>
        <Select
          label="评分来源"
          value={source}
          onChange={(event) => setSource(event.target.value as StaffSource)}
        >
          {(Object.keys(SOURCE_LABELS) as StaffSource[]).map((item) => (
            <option key={item} value={item}>{SOURCE_LABELS[item]}</option>
          ))}
        </Select>
        {criteria.map((criterion) => (
          <Input
            key={criterion.key}
            label={`${criterion.key}（${criterion.minimum ?? 0}–${criterion.maximum}）`}
            inputMode="decimal"
            value={values[criterion.key] ?? ""}
            onChange={(event) => setValues({ ...values, [criterion.key]: event.target.value })}
          />
        ))}
        <Input label="备注" value={notes} onChange={(event) => setNotes(event.target.value)} />
        {source === "staff_rapid" ? null : (
          <>
            <Input
              label="来源凭证"
              value={sourceReference}
              onChange={(event) => setSourceReference(event.target.value)}
              placeholder="纸面评分表编号或代录依据"
            />
            <Input
              label="录入说明"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="说明为什么由工作人员录入"
            />
          </>
        )}
        <Button variant="secondary" disabled={busy} onClick={() => void submit()}>
          提交补录
        </Button>
      </div>
      {error === null ? null : <p className="ui-field__error" role="alert">{error}</p>}
    </Card>
  );
}
