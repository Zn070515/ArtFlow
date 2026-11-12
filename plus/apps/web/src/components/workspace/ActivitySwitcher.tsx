import { useNavigate } from "@tanstack/react-router";

import type { WorkspaceActivity } from "./workspaceState.js";

export function ActivitySwitcher({
  activities,
  activeActivityId,
}: {
  readonly activities: readonly WorkspaceActivity[];
  readonly activeActivityId?: string;
}) {
  const navigate = useNavigate();

  if (activities.length === 0) return null;

  return (
    <label className="workspace-activity-switcher">
      <span>当前活动</span>
      <select
        aria-label="当前活动"
        value={activeActivityId ?? ""}
        onChange={(event) => {
          if (event.target.value === "") return;
          void navigate({
            to: "/workspace/$activityId",
            params: { activityId: event.target.value },
          });
        }}
      >
        <option value="" disabled>
          选择活动
        </option>
        {activities.map((activity) => (
          <option key={activity.id} value={activity.id}>
            {activity.title}
          </option>
        ))}
      </select>
    </label>
  );
}
