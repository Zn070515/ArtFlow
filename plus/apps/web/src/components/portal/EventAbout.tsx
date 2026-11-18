export function EventAbout({ description }: { readonly description: string }) {
  if (description.trim() === "") return null;
  return (
    <section className="event-section" id="about" aria-labelledby="event-about-title">
      <h2 className="event-section__title" id="event-about-title">
        关于本次活动
      </h2>
      <p className="event-about__copy">{description}</p>
    </section>
  );
}
