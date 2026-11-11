import type { ProgrammeProjection } from "../../api/programme.js";

const EMPTY_COPY: Readonly<Record<NonNullable<ProgrammeProjection["emptyReason"]>, string>> = {
  activity_not_active: "活动尚未发布，节目单还不能对外展示。",
  roster_not_final: "节目单尚未发布。名单定稿后，主持手卡和观众节目单会显示同一份顺序。",
  no_approved_programmes: "名单已定稿，目前没有通过的节目。",
};

export function ProgrammeView({
  programme,
  variant,
}: {
  readonly programme: ProgrammeProjection;
  readonly variant: "public" | "host";
}) {
  if (!programme.published || programme.items.length === 0) {
    const reason = programme.emptyReason ?? "roster_not_final";
    return (
      <section className="result-state">
        <p className="eyebrow">{variant === "host" ? "CUE · 主持" : "PROGRAMME · 节目单"}</p>
        <h1 className="state-title">{programme.activityTitle || "这场活动"}</h1>
        <p className="state-copy">{EMPTY_COPY[reason]}</p>
      </section>
    );
  }
  if (variant === "host") {
    return (
      <ol className="cue-deck">
        {programme.items.map((item) => (
          <li key={item.order} className="cue-card">
            <p className="cue-order">第 {item.order} 个</p>
            <h2 className="cue-title display">{item.title}</h2>
            <p className="cue-performers">{item.performers}</p>
            {item.notes === "" ? null : <p className="cue-notes">{item.notes}</p>}
          </li>
        ))}
      </ol>
    );
  }
  return (
    <ol className="programme-list">
      {programme.items.map((item) => (
        <li key={item.order}>
          <p className="eyebrow">第 {item.order} 个</p>
          <h2 className="console-card-title">{item.title}</h2>
          <p className="state-copy">{item.performers}</p>
          {item.notes === "" ? null : <p className="state-copy">{item.notes}</p>}
        </li>
      ))}
    </ol>
  );
}
