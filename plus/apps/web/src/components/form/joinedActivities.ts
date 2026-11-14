export interface JoinedActivity {
  readonly publicCode: string;
  readonly title: string;
  readonly joinedAt: string;
}

const STORAGE_KEY = "artflow-joined-activities";
const MAX_ENTRIES = 8;

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readJoinedActivities(): readonly JoinedActivity[] {
  const store = storage();
  if (store === null) return [];
  try {
    const raw = store.getItem(STORAGE_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is JoinedActivity =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as JoinedActivity).publicCode === "string" &&
      typeof (entry as JoinedActivity).title === "string",
    );
  } catch {
    return [];
  }
}

/** Remember the last few activities this browser joined. The participant can
 * return to their registration without having to remember the public code. */
export function rememberJoinedActivity(publicCode: string, title: string): void {
  const store = storage();
  if (store === null) return;
  const now = new Date().toISOString();
  const next = [
    { publicCode, title, joinedAt: now },
    ...readJoinedActivities().filter((entry) => entry.publicCode !== publicCode),
  ].slice(0, MAX_ENTRIES);
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // A full or blocked storage must not break the registration form.
  }
}
