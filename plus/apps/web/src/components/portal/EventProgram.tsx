import { useState } from "react";

import type { PublicEventSite } from "../../api/publicEvent.js";

function formatEntryTime(value: string | null): string {
  if (value === null) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function EventProgram({ site }: { readonly site: PublicEventSite }) {
  const [hostMode, setHostMode] = useState(false);
  const schedule = site.schedule;
  const program = site.program;
  if (schedule === null && (program === null || program.entries.length === 0)) return null;
  return (
    <section className="event-section" id="program" aria-labelledby="event-program-title">
      <div className="event-section__head">
        <h2 className="event-section__title" id="event-program-title">
          节目单
        </h2>
        <div className="event-section__actions">
          <label className="event-toggle">
            <input
              type="checkbox"
              checked={hostMode}
              onChange={(event) => setHostMode(event.target.checked)}
            />
            主持大字
          </label>
          <button
            type="button"
            className="event-button event-button--ghost"
            onClick={() => window.print()}
          >
            打印
          </button>
        </div>
      </div>
      <ol className={hostMode ? "event-program event-program--host" : "event-program"}>
        {schedule !== null
          ? schedule.entries.map((entry) => (
              <li className="event-program__row" key={`${entry.order}-${entry.title}`}>
                <span className="event-program__time">
                  {formatEntryTime(entry.startsAt) || entry.slotLabel}
                </span>
                <span className="event-program__title">{entry.title}</span>
                {entry.note === "" ? null : (
                  <span className="event-program__note">{entry.note}</span>
                )}
              </li>
            ))
          : program?.entries.map((entry) => (
              <li className="event-program__row" key={`${entry.order}-${entry.name}`}>
                <span className="event-program__title">{entry.name}</span>
                {entry.song === "" ? null : (
                  <span className="event-program__note">{entry.song}</span>
                )}
                {entry.note === "" ? null : (
                  <span className="event-program__note">{entry.note}</span>
                )}
              </li>
            ))}
      </ol>
    </section>
  );
}
