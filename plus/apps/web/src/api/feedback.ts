import { apiFetch } from "./client.js";

export interface ActivityFeedbackItem {
  readonly id: string;
  readonly activityId: string;
  readonly rating: number;
  readonly comment: string;
  readonly source: string;
  readonly submittedAt: string;
}

export interface ActivityFeedbackView {
  readonly items: readonly ActivityFeedbackItem[];
  readonly summary: {
    readonly count: number;
    readonly average: number | null;
  };
}

export async function submitFeedback(
  publicCode: string,
  rating: number,
  comment: string,
  website = "",
): Promise<void> {
  await apiFetch(`/api/public/activities/${encodeURIComponent(publicCode)}/feedback`, {
    method: "POST",
    headers: { "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({
      rating,
      comment,
      ...(website === "" ? {} : { website }),
    }),
  });
}

export function fetchActivityFeedback(activityId: string): Promise<ActivityFeedbackView> {
  return apiFetch(`/api/activities/${encodeURIComponent(activityId)}/feedback`);
}
