import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import type { OpsRegistration } from "../../api/ops.js";
import { ConsolePagination } from "../console/ConsolePagination.js";

const PAGE_SIZE = 25;

const STATUS_LABELS: Readonly<Record<string, string>> = {
  draft: "草稿",
  submitted: "已提交",
  approved: "已通过",
  need_supplement: "需补充",
  rejected: "未通过",
};

function answerText(registration: OpsRegistration, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = registration.answers[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return undefined;
}

function registrationName(registration: OpsRegistration): string {
  return answerText(registration, ["name", "displayName", "title", "负责人"]) ?? registration.participantId;
}

function registrationSubtitle(registration: OpsRegistration): string {
  return [
    answerText(registration, ["student_id", "studentId"]),
    answerText(registration, ["song", "program", "program_name"]),
  ].filter((value): value is string => value !== undefined).join(" · ");
}

function searchableText(registration: OpsRegistration): string {
  const answers = Object.values(registration.answers)
    .filter((value): value is string => typeof value === "string")
    .join(" ");
  return `${registration.participantId} ${registration.reviewNote ?? ""} ${answers}`.toLocaleLowerCase();
}

export function RegistrationTable({
  activityId,
  registrations,
}: {
  readonly activityId: string;
  readonly registrations: readonly OpsRegistration[];
}) {
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [searchTerm, statusFilter]);

  if (registrations.length === 0) {
    return <p className="state-copy">还没有报名。</p>;
  }
  const normalizedSearch = searchTerm.trim().toLocaleLowerCase();
  const statuses = [...new Set(registrations.map((registration) => registration.status))].sort();
  const filteredRegistrations = registrations.filter((registration) => {
    const matchesSearch = normalizedSearch.length === 0 ||
      searchableText(registration).includes(normalizedSearch);
    return matchesSearch && (statusFilter.length === 0 || registration.status === statusFilter);
  });
  const totalPages = Math.max(1, Math.ceil(filteredRegistrations.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const paginatedRegistrations = filteredRegistrations.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  return (
    <>
      <div className="console-table-toolbar" role="search" aria-label="报名筛选">
        <label className="console-filter-field">
          搜索报名
          <input
            type="search"
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
            placeholder="搜索姓名、学号、曲目或审核意见"
          />
        </label>
        <label className="console-filter-field">
          按报名状态筛选
          <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
            <option value="">全部状态</option>
            {statuses.map((status) => <option key={status} value={status}>{STATUS_LABELS[status] ?? status}</option>)}
          </select>
        </label>
      </div>
      {filteredRegistrations.length === 0 ? (
        <p className="state-copy">没有匹配的报名。</p>
      ) : (
        <>
          <table className="data-table">
            <caption>报名列表</caption>
            <thead>
              <tr>
                <th scope="col">参与者</th>
                <th scope="col">学号 / 曲目</th>
                <th scope="col">状态</th>
                <th scope="col">修订</th>
                <th scope="col">审核意见</th>
              </tr>
            </thead>
            <tbody>
              {paginatedRegistrations.map((registration) => (
                <tr key={registration.id}>
                  <td>
                    <Link
                      to="/ops/$activityId/registrations/$registrationId"
                      params={{ activityId, registrationId: registration.id }}
                      className="table-link"
                    >
                      {registrationName(registration)}
                    </Link>
                    <span className="state-copy"> {registration.participantId}</span>
                  </td>
                  <td>{registrationSubtitle(registration) || "—"}</td>
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
          <ConsolePagination page={currentPage} totalPages={totalPages} onPageChange={setPage} />
        </>
      )}
    </>
  );
}
