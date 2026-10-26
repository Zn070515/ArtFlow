import { useEffect, useRef, useState } from "react";

/**
 * Subscribes to the activity event stream. SSE is only an invalidation hint:
 * when the stream fails the caller falls back to interval polling.
 */
export function useLiveEvents(
  activityId: string,
  enabled: boolean,
  onChange: () => void,
): boolean {
  const [fallback, setFallback] = useState(false);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!enabled || typeof EventSource === "undefined") {
      setFallback(!enabled ? false : true);
      return;
    }
    setFallback(false);
    const source = new EventSource(`/api/activities/${activityId}/stream`);
    source.onmessage = () => onChangeRef.current();
    source.onerror = () => {
      source.close();
      setFallback(true);
    };
    return () => source.close();
  }, [activityId, enabled]);

  return fallback;
}
