import type { MyEvent } from "../../api/me.js";

export function MeSchedule({ event }: { readonly event: MyEvent }) {
  return (
    <section className="me-detail__section">
      <h2>我的赛程</h2>
      {event.schedule.length === 0 ? (
        <p className="state-copy">节目单尚未发布或没有你的条目</p>
      ) : (
        <ol className="me-schedule-list">
          {event.schedule.map((entry) => (
            <li key={`${entry.order}-${entry.title}`}>
              <span>
                {entry.startsAt === null ? entry.slotLabel : new Date(entry.startsAt).toLocaleString("zh-CN")}
              </span>
              <strong>{entry.title}</strong>
              {entry.note === "" ? null : <span className="ui-card__description">{entry.note}</span>}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
