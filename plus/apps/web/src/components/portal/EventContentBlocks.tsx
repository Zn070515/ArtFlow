import type { PublicEventSite } from "../../api/publicEvent.js";

type Profile = PublicEventSite["profile"];

function formatPublishedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function EventAnnouncements({
  items,
}: {
  readonly items: Profile["announcements"];
}) {
  if (items.length === 0) return null;
  const sorted = [...items].sort((left, right) => right.publishedAt.localeCompare(left.publishedAt));
  return (
    <section className="event-section" id="announcements" aria-labelledby="event-announcements-title">
      <h2 className="event-section__title" id="event-announcements-title">公告</h2>
      <ol className="event-announcements">
        {sorted.map((item) => (
          <li key={item.id}>
            <p className="event-announcements__meta">{formatPublishedAt(item.publishedAt)}</p>
            <h3 className="event-announcements__title">{item.title}</h3>
            <p className="event-announcements__body">{item.body}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function EventFaq({ items }: { readonly items: Profile["faq"] }) {
  if (items.length === 0) return null;
  return (
    <section className="event-section" id="faq" aria-labelledby="event-faq-title">
      <h2 className="event-section__title" id="event-faq-title">常见问题</h2>
      <div className="event-faq">
        {items.map((item, index) => (
          <details className="event-faq__item" key={`faq-${index}`}>
            <summary>{item.question}</summary>
            <p>{item.answer}</p>
          </details>
        ))}
      </div>
    </section>
  );
}

export function EventLinks({ items }: { readonly items: Profile["links"] }) {
  if (items.length === 0) return null;
  return (
    <section className="event-section" id="links" aria-labelledby="event-links-title">
      <h2 className="event-section__title" id="event-links-title">相关链接</h2>
      <ul className="event-links">
        {items.map((item, index) => (
          <li key={`link-${index}`}>
            <a href={item.url} target="_blank" rel="noreferrer noopener">{item.label}</a>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function EventParticipants({
  items,
}: {
  readonly items: PublicEventSite["participants"];
}) {
  if (items === null || items.length === 0) return null;
  return (
    <section className="event-section" id="participants" aria-labelledby="event-participants-title">
      <h2 className="event-section__title" id="event-participants-title">参与者</h2>
      <ul className="event-participants">
        {items.map((item, index) => (
          <li key={`participant-${index}-${item.name}`}>
            <span>{item.name}</span>
            {item.program === "" ? null : (
              <span className="event-participants__program">{item.program}</span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
