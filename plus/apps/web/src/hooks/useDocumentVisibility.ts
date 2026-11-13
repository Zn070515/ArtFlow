import { useEffect, useState } from "react";

/** True while the tab is hidden; WebGL and polling loops should pause. */
export function useDocumentVisibility(): boolean {
  const [hidden, setHidden] = useState(
    () => typeof document !== "undefined" && document.visibilityState === "hidden",
  );

  useEffect(() => {
    const update = (): void => setHidden(document.visibilityState === "hidden");
    document.addEventListener("visibilitychange", update);
    update();
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  return hidden;
}
