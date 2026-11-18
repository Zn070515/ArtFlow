import { useEffect, useState } from "react";

export interface AnnouncementBannerProps {
  readonly publicCode: string;
  readonly announcement: string;
}

function storageKey(publicCode: string): string {
  return `artflow.announcement.${publicCode}`;
}

function dismissedText(publicCode: string): string | null {
  try {
    return window.sessionStorage.getItem(storageKey(publicCode));
  } catch {
    return null;
  }
}

function rememberDismissed(publicCode: string, text: string): void {
  try {
    window.sessionStorage.setItem(storageKey(publicCode), text);
  } catch {
    // Private mode: showing the announcement again is the safe fallback.
  }
}

export function AnnouncementBanner({ publicCode, announcement }: AnnouncementBannerProps) {
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    setDismissed(dismissedText(publicCode) === announcement);
  }, [publicCode, announcement]);
  if (announcement.trim() === "" || dismissed) return null;
  return (
    <aside className="event-announcement event-announcement--banner" role="note" aria-label="现场公告">
      <p className="event-announcement__text">{announcement}</p>
      <button
        type="button"
        className="event-announcement__close"
        aria-label="关闭公告"
        onClick={() => {
          rememberDismissed(publicCode, announcement);
          setDismissed(true);
        }}
      >
        ×
      </button>
    </aside>
  );
}
