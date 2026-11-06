import { Component, lazy, Suspense, type ReactNode } from "react";

const LazyAuroraCanvas = lazy(() => import("./AuroraCanvas.js"));

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
  if (reducedMotion) return <StaticBackdrop />;
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
