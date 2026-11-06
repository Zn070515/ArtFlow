import { useEffect, useRef, useState } from "react";

import { getRealtimeClient } from "./client.js";

export function useRealtimeTopic<T>(
  topic: string | null,
  onData: (data: T, seq: number) => void,
): { readonly fallback: boolean } {
  const [fallback, setFallback] = useState(false);
  const onDataRef = useRef(onData);
  onDataRef.current = onData;

  useEffect(() => {
    const client = getRealtimeClient();
    const offFallback = client.onFallbackChange(setFallback);
    if (topic === null) return offFallback;
    const unsubscribe = client.subscribe<T>(topic, {
      onSnapshot: (data, seq) => onDataRef.current(data, seq),
      onUpdate: (data, seq) => onDataRef.current(data, seq),
    });
    return () => {
      unsubscribe();
      offFallback();
    };
  }, [topic]);

  return { fallback };
}
