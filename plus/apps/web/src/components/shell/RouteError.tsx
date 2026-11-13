import type { ErrorComponentProps } from "@tanstack/react-router";

import { Button } from "../ui/Button.js";

/**
 * Route-level boundary: a render error never blanks the whole shell. A reload
 * also recovers a failed lazy-route chunk, which `reset` alone cannot do.
 */
export function RouteError(_props: ErrorComponentProps) {
  return (
    <section className="ui-state ui-state--error" role="alert">
      <h2 className="ui-state__title">页面出错了</h2>
      <p className="ui-state__copy">请重新加载页面；如果仍然失败，请稍后再试。</p>
      <div className="ui-state__action">
        <Button variant="secondary" onClick={() => window.location.reload()}>
          重新加载
        </Button>
      </div>
    </section>
  );
}

export function RoutePending() {
  return <p className="auth-loading">正在加载…</p>;
}
