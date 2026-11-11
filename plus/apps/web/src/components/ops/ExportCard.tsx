export function ExportCard({
  activityId,
  permissions,
}: {
  readonly activityId: string;
  readonly permissions: readonly string[];
}) {
  const can = (permission: string): boolean =>
    permissions.includes("*") || permissions.includes(permission);
  const links = [
    {
      kind: "registrations",
      label: "报名名单",
      enabled: can("registration.review") || can("registration.manage"),
    },
    {
      kind: "materials",
      label: "材料清单",
      enabled: can("registration.review") || can("registration.manage"),
    },
    { kind: "scores", label: "评委评分", enabled: can("competition.manage") },
    {
      kind: "votes",
      label: "观众票",
      enabled: can("result.manage") || can("voting.manage"),
    },
  ].filter((link) => link.enabled);

  if (links.length === 0) return null;
  return (
    <section className="ops-card" data-testid="ops-export-card">
      <p className="eyebrow">EXPORT · 导出</p>
      <h2 className="console-card-title">受控导出</h2>
      <p className="state-copy">CSV 导出会写审计；空数据也会生成表头。</p>
      <ul className="seat-list">
        {links.map((link) => (
          <li key={link.kind}>
            <a
              className="table-link"
              href={`/api/activities/${encodeURIComponent(activityId)}/exports/${link.kind}`}
              download
            >
              {link.label}
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
