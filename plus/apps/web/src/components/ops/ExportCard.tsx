const EXPORTS = [
  {
    kind: "registrations",
    label: "导出报名表",
    permissions: ["registration.review", "registration.manage"],
  },
  {
    kind: "materials",
    label: "导出材料清单",
    permissions: ["registration.review", "registration.manage", "materials.review", "materials.manage"],
  },
  {
    kind: "scores",
    label: "导出评分表",
    permissions: ["competition.manage"],
  },
  {
    kind: "votes",
    label: "导出观众票",
    permissions: ["voting.manage", "competition.manage"],
  },
] as const;

function allowed(permissions: readonly string[], required: readonly string[]): boolean {
  return permissions.includes("*") || required.some((permission) => permissions.includes(permission));
}

export function ExportCard({
  activityId,
  permissions,
}: {
  readonly activityId: string;
  readonly permissions: readonly string[];
}) {
  const links = EXPORTS.filter((item) => allowed(permissions, item.permissions));
  if (links.length === 0) return null;
  return (
    <section className="ops-card">
      <p className="eyebrow">EXPORT · 表格</p>
      <h2 className="console-card-title">导出</h2>
      <p className="state-copy">下载报名、材料清单、评分或观众票。文件不含作品文件本身；空名单和未定稿名单也会给出表格。</p>
      <ul className="export-links">
        {links.map((item) => (
          <li key={item.kind}>
            <a
              className="table-link"
              href={`/api/activities/${activityId}/exports/${item.kind}`}
              download={`${item.kind}.csv`}
            >
              {item.label}
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
