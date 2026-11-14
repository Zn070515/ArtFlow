/** One place for the strings a business user should see. Internal enum values
 * never reach the page when a label exists here. */

export const ACTIVITY_STATUS_LABELS: Readonly<Record<string, string>> = {
  draft: "草稿",
  active: "进行中",
  closed: "已结束",
  archived: "已归档",
};

export const CAPABILITY_LABELS: Readonly<Record<string, string>> = {
  registration: "报名",
  questionnaire: "问卷",
  materials: "材料",
  competition: "比赛",
  voting: "投票",
  publishing: "发布",
  archive: "归档",
  grouping: "分组",
  tasks: "任务",
  attendance: "签到",
  ticketing: "票据",
  schedule: "排期",
  analytics: "运营分析",
};

export const REGISTRATION_STATUS_LABELS: Readonly<Record<string, string>> = {
  draft: "草稿",
  submitted: "已提交",
  approved: "已通过",
  need_supplement: "需补充",
  rejected: "未通过",
};

export const EXECUTION_MODE_LABELS: Readonly<Record<string, string>> = {
  test: "测试",
  rehearsal: "彩排",
  formal: "正式",
};

export const EXECUTION_STATUS_LABELS: Readonly<Record<string, string>> = {
  running: "运行中",
  closed: "已关闭",
};

export const ROUND_STATE_LABELS: Readonly<Record<string, string>> = {
  prepared: "已准备",
  scoring: "评分中",
  locked: "已锁定",
};

export const PERFORMANCE_STATE_LABELS: Readonly<Record<string, string>> = {
  not_opened: "未开始",
  open: "进行中",
  locked: "已锁定",
};

export const SEAT_STATE_LABELS: Readonly<Record<string, string>> = {
  available: "可用",
  assigned: "已分配",
  claimed: "已认领",
  revoked: "已撤销",
};

export const SCORING_METHOD_LABELS: Readonly<Record<string, string>> = {
  average: "平均分",
  sum: "总分",
  median: "中位数",
  trimmed_mean: "去极值平均",
};

export const AGGREGATE_STATUS_LABELS: Readonly<Record<string, string>> = {
  ...REGISTRATION_STATUS_LABELS,
  ...ACTIVITY_STATUS_LABELS,
  ...ROUND_STATE_LABELS,
  ...PERFORMANCE_STATE_LABELS,
  uploaded: "已上传",
  pending: "待处理",
  active: "生效",
  revoked: "已撤销",
  superseded: "已替代",
  confirmed: "已确认",
  candidate: "候选",
  hold: "暂缓",
  open: "进行中",
  closed: "已关闭",
};

export function label(
  labels: Readonly<Record<string, string>>,
  value: string | null | undefined,
  fallback = "—",
): string {
  if (value === null || value === undefined || value === "") return fallback;
  return labels[value] ?? fallback;
}

export function capabilityLabel(value: string): string {
  return CAPABILITY_LABELS[value] ?? "其他能力";
}

export function capabilityLabels(values: readonly string[]): string {
  return values.length === 0 ? "—" : values.map(capabilityLabel).join("、");
}

export function participantLabel(
  names: Readonly<Record<string, string>> | undefined,
  participantId: string,
  fallback = "选手",
): string {
  const name = names?.[participantId];
  return typeof name === "string" && name.trim() !== "" ? name : fallback;
}
