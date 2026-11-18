import { apiFetch } from "./client.js";

export type MyRegistrationStatus =
  | "draft"
  | "submitted"
  | "need_supplement"
  | "approved"
  | "rejected"
  | "withdrawn";

export type MyMaterialStatus = "uploaded" | "approved" | "needs_supplement";

export interface MyEvent {
  readonly activity: {
    readonly publicCode: string;
    readonly title: string;
    readonly status: "draft" | "active" | "closed" | "archived";
    readonly startsAt: string | null;
    readonly endsAt: string | null;
    readonly venue: string;
    readonly organizer: string;
  };
  readonly registration: {
    readonly status: MyRegistrationStatus;
    readonly editable: boolean;
    readonly reviewNote?: string;
    readonly supplementKeys: readonly string[];
    readonly createdAt: string;
    readonly updatedAt: string;
  };
  readonly materials: readonly {
    readonly id: string;
    readonly questionKey: string;
    readonly originalName: string;
    readonly contentType: string;
    readonly byteLength: number;
    readonly status: MyMaterialStatus;
    readonly reviewNote: string;
    readonly revision: number;
    readonly contentPath: string | null;
    readonly reviewedAt: string | null;
    readonly updatedAt: string | null;
  }[];
  readonly schedule: readonly {
    readonly order: number;
    readonly slotLabel: string;
    readonly title: string;
    readonly note: string;
    readonly startsAt: string | null;
  }[];
  readonly results: readonly {
    readonly stageKey: string;
    readonly publicTitle: string;
    readonly releasedAt: string;
    readonly rank: number;
    readonly score: string;
    readonly unit?: "score" | "percent";
    readonly awards: readonly string[];
  }[];
  readonly links: { readonly event: string | null; readonly edit: string | null };
  readonly archived: boolean;
}

export interface MyNotification {
  readonly key: string;
  readonly kind: "registration" | "material" | "announcement" | "schedule" | "result";
  readonly title: string;
  readonly body: string;
  readonly activity: { readonly publicCode: string; readonly title: string };
  readonly createdAt: string;
  readonly read: boolean;
  readonly href: string;
}

export interface MyCenter {
  readonly events: readonly MyEvent[];
  readonly notifications: {
    readonly items: readonly MyNotification[];
    readonly unreadCount: number;
  };
}

export function fetchMyCenter(signal?: AbortSignal): Promise<MyCenter> {
  return apiFetch<MyCenter>("/api/me", { signal });
}

export function markMyNotificationsRead(
  keys: readonly string[],
): Promise<{ unreadCount: number }> {
  return apiFetch("/api/me/notifications/read", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ keys }),
  });
}
