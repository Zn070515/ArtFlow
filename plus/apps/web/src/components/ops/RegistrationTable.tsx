import { Link } from "@tanstack/react-router";

import type { OpsRegistration } from "../../api/ops.js";

const STATUS_LABELS: Readonly<Record<string, string>> = {
  draft: "草稿",
  submitted: "已提交",
  approved: "已通过",
  need_supplement: "需补充",
  rejected: "未通过",
};

export function RegistrationTable({
  activityId,
  registrations,
}: {
  readonly activityId: string;
  readonly registrations: readonly OpsRegistration[];
}) {
  if (registrations.length === 0) {
    return <p className="state-copy">还没有报名。</p>;
  }
  return (
    <table className="data-table">
      <caption>报名列表</caption>
      <thead>
        <tr>
          <th scope="col">参与者</th>
          <th scope="col">状态</th>
          <th scope="col">修订</th>
          <th scope="col">审核意见</th>
        </tr>
      </thead>
      <tbody>
        {registrations.map((registration) => (
          <tr key={registration.id}>
            <td>
              <Link
                to="/ops/$activityId/registrations/$registrationId"
                params={{ activityId, registrationId: registration.id }}
                className="table-link"
              >
                {registration.participantId}
              </Link>
            </td>
            <td>
              <span className={`status-badge status-${registration.status}`}>
                {STATUS_LABELS[registration.status] ?? registration.status}
              </span>
            </td>
            <td>{registration.revision}</td>
            <td>{registration.reviewNote ?? "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
