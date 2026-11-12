import { Component, lazy, Suspense, useEffect, useState, type ReactNode } from "react";

const LazyAuroraCanvas = lazy(() => import("./AuroraCanvas.js"));
const NARROW_QUERY = "(max-width: 767px)";

function StaticBackdrop() {
  return <div className="static-backdrop" data-testid="static-backdrop" aria-hidden="true" />;
}

class SceneBoundary extends Component<{ readonly children: ReactNode }, { readonly failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  render(): ReactNode {
    return this.state.failed ? <StaticBackdrop /> : this.props.children;
  }
}

export function AuroraScene({ reducedMotion }: { readonly reducedMotion: boolean }) {
  const [narrow, setNarrow] = useState(
    () => typeof window !== "undefined" && window.matchMedia(NARROW_QUERY).matches,
  );

  useEffect(() => {
    const media = window.matchMedia(NARROW_QUERY);
    const update = (): void => setNarrow(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  if (reducedMotion || narrow) return <StaticBackdrop />;
  return (
    <div className="aurora" aria-hidden="true">
      <SceneBoundary>
        <Suspense fallback={<StaticBackdrop />}>
          <LazyAuroraCanvas />
        </Suspense>
      </SceneBoundary>
    </div>
  );
}
