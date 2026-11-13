import { ErrorState } from "../ui/ErrorState.js";

/** Route-level boundary: a render error never blanks the whole shell. */
export function RouteError({ reset }: { readonly error: Error; readonly reset: () => void }) {
  return (
    <ErrorState
      title="页面出错了"
      description="这部分内容暂时无法显示。可以重试，或返回上一页。"
      onRetry={reset}
    />
  );
}

export function RoutePending() {
  return <p className="auth-loading">正在加载…</p>;
}
