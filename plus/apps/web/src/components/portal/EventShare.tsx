import { useState } from "react";

type ShareState = "idle" | "copied" | "error";

export function EventShare({ title }: { readonly title: string }) {
  const [status, setStatus] = useState<ShareState>("idle");

  async function share(): Promise<void> {
    const url = window.location.href;
    const nativeShare = navigator.share as
      | ((data: { readonly title: string; readonly url: string }) => Promise<void>)
      | undefined;
    try {
      if (typeof nativeShare === "function") {
        await nativeShare({ title, url });
        return;
      }
      if (navigator.clipboard === undefined) {
        setStatus("error");
        window.setTimeout(() => setStatus("idle"), 2000);
        return;
      }
      await navigator.clipboard.writeText(url);
      setStatus("copied");
      window.setTimeout(() => setStatus("idle"), 2000);
    } catch {
      setStatus("error");
      window.setTimeout(() => setStatus("idle"), 2000);
    }
  }

  return (
    <>
      <button type="button" className="event-button event-button--ghost" onClick={() => void share()}>
        分享
      </button>
      <span className="event-share-status" role="status">
        {status === "copied" ? "链接已复制" : status === "error" ? "复制失败，请手动复制地址" : ""}
      </span>
    </>
  );
}
