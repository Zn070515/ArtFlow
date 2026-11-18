import * as QRCode from "qrcode";
import { useEffect, useRef, useState } from "react";

type ShareState = "idle" | "copied" | "error";

function canonicalUrl(publicCode: string): string {
  return new URL(`/e/${encodeURIComponent(publicCode)}`, window.location.origin).toString();
}

export function EventShare({ title, publicCode }: { readonly title: string; readonly publicCode: string }) {
  const [status, setStatus] = useState<ShareState>("idle");
  const [qrOpen, setQrOpen] = useState(false);
  const [qr, setQr] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null || typeof dialog.showModal !== "function") return;
    if (qrOpen && !dialog.open) dialog.showModal();
    if (!qrOpen && dialog.open) dialog.close();
  }, [qrOpen]);

  useEffect(() => {
    if (!qrOpen) return;
    let cancelled = false;
    void QRCode.toDataURL(canonicalUrl(publicCode), { margin: 1, width: 240 })
      .then((url) => {
        if (!cancelled) setQr(url);
      })
      .catch(() => {
        if (!cancelled) setQr(null);
      });
    return () => {
      cancelled = true;
    };
  }, [qrOpen, publicCode]);

  async function share(): Promise<void> {
    const url = canonicalUrl(publicCode);
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
      <button type="button" className="event-button event-button--ghost" onClick={() => setQrOpen(true)}>
        二维码
      </button>
      <span className="event-share-status" role="status">
        {status === "copied" ? "链接已复制" : status === "error" ? "复制失败，请手动复制地址" : ""}
      </span>
      <dialog
        ref={dialogRef}
        className="event-qr-dialog"
        aria-labelledby="event-qr-title"
        onClose={() => setQrOpen(false)}
      >
        <h2 className="event-qr-dialog__title" id="event-qr-title">现场二维码</h2>
        {qr === null ? (
          <p>正在生成…</p>
        ) : (
          <img src={qr} alt={`${title} 活动二维码`} width={240} height={240} />
        )}
        <p className="event-qr-dialog__url">{canonicalUrl(publicCode)}</p>
        <button type="button" className="event-button" onClick={() => dialogRef.current?.close()}>
          关闭
        </button>
      </dialog>
    </>
  );
}
