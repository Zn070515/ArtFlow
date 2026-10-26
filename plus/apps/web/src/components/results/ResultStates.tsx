import { Link } from "@tanstack/react-router";

export function LoadingState() {
  return (
    <section className="result-state" aria-busy="true" aria-live="polite">
      <p className="eyebrow">RESULTS</p>
      <div className="skeleton skeleton-title" />
      <div className="skeleton skeleton-row" />
      <div className="skeleton skeleton-row" />
      <span className="sr-only">正在加载赛果</span>
    </section>
  );
}

export function NotFoundState({ publicCode }: { readonly publicCode: string }) {
  return (
    <section className="result-state">
      <p className="eyebrow">NOT FOUND</p>
      <h1 className="state-title">没有找到这场活动的结果</h1>
      <p className="state-copy">公开码「{publicCode}」不存在，或结果尚未发布。</p>
      <Link className="state-link" to="/">
        返回重新输入
      </Link>
    </section>
  );
}

export function EmptyState({ activityTitle }: { readonly activityTitle: string }) {
  return (
    <section className="result-state">
      <p className="eyebrow">COMING SOON</p>
      <h1 className="state-title">{activityTitle || "这场活动"}的结果尚未发布</h1>
      <p className="state-copy">正式赛果发布后会出现在这里。</p>
      <Link className="state-link" to="/">
        返回
      </Link>
    </section>
  );
}

export function ErrorState({ onRetry }: { readonly onRetry: () => void }) {
  return (
    <section className="result-state">
      <p className="eyebrow">SOMETHING WENT WRONG</p>
      <h1 className="state-title">赛果暂时加载失败</h1>
      <p className="state-copy">网络或服务暂时不可用，请稍后重试。</p>
      <button className="state-link" type="button" onClick={onRetry}>
        重新加载
      </button>
    </section>
  );
}
