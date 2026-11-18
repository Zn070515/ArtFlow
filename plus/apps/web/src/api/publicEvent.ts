export interface PublicEventSite {
  readonly activity: {
    readonly publicCode: string;
    readonly title: string;
    readonly status: "active" | "closed";
    readonly registrationEnabled: boolean;
    readonly registrationOpen: boolean;
  };
  readonly profile: {
    readonly tagline: string;
    readonly description: string;
    readonly venue: string;
    readonly startsAt: string | null;
    readonly endsAt: string | null;
    readonly organizer: string;
    readonly contact: string;
    readonly announcement: string;
  };
  readonly schedule: {
    readonly entries: readonly {
      readonly order: number;
      readonly slotLabel: string;
      readonly title: string;
      readonly note: string;
      readonly startsAt: string | null;
    }[];
  } | null;
  readonly program: {
    readonly entries: readonly {
      readonly order: number;
      readonly name: string;
      readonly song: string;
      readonly note: string;
      readonly startsAt: string | null;
    }[];
  } | null;
  readonly results: {
    readonly activityTitle: string;
    readonly results: readonly {
      readonly stageKey: string;
      readonly publicTitle: string;
      readonly releasedAt: string;
      readonly decisions: readonly {
        readonly rank: number;
        readonly contestantName: string;
        readonly score: string;
        readonly unit?: "score" | "percent";
      }[];
      readonly awards: readonly {
        readonly award: string;
        readonly contestantName: string;
      }[];
    }[];
  } | null;
}

export class PublicEventNotFound extends Error {
  constructor(publicCode: string) {
    super(`No public event for ${publicCode}`);
    this.name = "PublicEventNotFound";
  }
}

export async function fetchPublicEvent(
  publicCode: string,
  signal?: AbortSignal,
): Promise<PublicEventSite> {
  const response = await fetch(`/api/public/events/${encodeURIComponent(publicCode)}`, {
    signal,
    headers: { accept: "application/json" },
  });
  if (response.status === 404) throw new PublicEventNotFound(publicCode);
  if (!response.ok) throw new Error(`加载活动失败（${response.status}）`);
  return (await response.json()) as PublicEventSite;
}
