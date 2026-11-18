import { useState } from "react";

import { Button } from "../ui/Button.js";

type CopyState = "idle" | "copied" | "error";

export function EmbedSnippet({ publicCode }: { readonly publicCode: string }) {
  const [status, setStatus] = useState<CopyState>("idle");
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const src = `${origin}/embed/${encodeURIComponent(publicCode)}`;
  const snippet = `<iframe src="${src}" title="活动" width="360" height="480" loading="lazy" style="border:0;border-radius:12px"></iframe>`;

  async function copy(): Promise<void> {
    if (navigator.clipboard === undefined) {
      setStatus("error");
      window.setTimeout(() => setStatus("idle"), 2000);
      return;
    }
    try {
      await navigator.clipboard.writeText(snippet);
      setStatus("copied");
    } catch {
      setStatus("error");
    }
    window.setTimeout(() => setStatus("idle"), 2000);
  }

  return (
    <div className="embed-snippet">
      <pre className="embed-snippet__code"><code>{snippet}</code></pre>
      <div className="embed-snippet__actions">
        <Button variant="secondary" size="sm" onClick={() => void copy()}>
          复制嵌入代码
        </Button>
        <span role="status" className="event-share-status">
          {status === "copied" ? "已复制" : status === "error" ? "复制失败，请手动复制" : ""}
        </span>
      </div>
      <p className="embed-snippet__hint">
        嵌入页只读公开信息；点击链接会打开完整活动页。
      </p>
    </div>
  );
}
