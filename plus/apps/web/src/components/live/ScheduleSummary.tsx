import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { advanceSchedule, fetchSchedule, type ScheduleMode } from "../../api/schedule.js";
import { apiErrorText } from "../ui/apiError.js";
import { Button } from "../ui/Button.js";
import { Card } from "../ui/Card.js";

function scheduleMode(mode: "test" | "rehearsal" | "formal" | undefined): ScheduleMode {
  return mode ?? "formal";
}

export function ScheduleSummary({
  activityId,
  mode,
}: {
  readonly activityId: string;
  readonly mode: "test" | "rehearsal" | "formal" | undefined;
}) {
  const queryClient = useQueryClient();
  const currentMode = scheduleMode(mode);
  const query = useQuery({
    queryKey: ["schedule", activityId, currentMode],
    queryFn: () => fetchSchedule(activityId, currentMode),
    retry: false,
  });
  const advance = useMutation({
    mutationFn: () => advanceSchedule(activityId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["schedule", activityId, currentMode] });
    },
  });
  const data = query.data;
  if (data === undefined || data.entries.length === 0) return null;
  const currentIndex = data.entries.findIndex((entry) => entry.id === data.currentEntryId);
  const current = currentIndex < 0 ? undefined : data.entries[currentIndex];
  const next = data.entries[currentIndex + 1];

  return (
    <Card className="live-schedule-card" data-testid="live-schedule-card">
      <h2 className="ui-card__title">节目排期</h2>
      <p className="ui-card__description">
        当前：{current?.title ?? "未开始"}
        {next === undefined ? "" : ` · 下一位：${next.title}`}
      </p>
      <Button
        variant="secondary"
        disabled={advance.isPending}
        onClick={() => advance.mutate()}
      >
        下一位
      </Button>
      {advance.error === null ? null : (
        <p className="ui-field__error" role="alert">
          {apiErrorText(advance.error, "切换节目失败，请先启动排期会话。", "排期已更新，请刷新重试。")}
        </p>
      )}
    </Card>
  );
}
