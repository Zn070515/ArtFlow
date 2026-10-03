declare const ZXingBrowser: {
  BrowserQRCodeReader: new () => {
    decodeFromVideoDevice(
      deviceId: string | undefined,
      video: HTMLVideoElement,
      callback: (result: { getText(): string } | undefined) => void,
    ): Promise<unknown>;
  };
};

(() => {
  "use strict";

  const root = document.querySelector<HTMLElement>("[data-ticket-check-in-root]");
  if (!root) return;
  const scannerRoot = root;
  const video = root.querySelector<HTMLVideoElement>("[data-ticket-camera]");
  const status = root.querySelector<HTMLElement>("[data-ticket-check-in-status]");
  const form = root.querySelector<HTMLFormElement>("[data-ticket-check-in-form]");
  const input = root.querySelector<HTMLInputElement>("[name='secret']");
  const endpoint = root.dataset.checkInUrl || "/staff/tickets/check-in/";
  let busy = false;
  let lastCredential = "";
  let lastCredentialAt = 0;

  function credential(value: string): string {
    const trimmed = value.trim();
    if (!trimmed) return "";
    try {
      const parsed = new URL(trimmed, window.location.origin);
      if (parsed.hash) return decodeURIComponent(parsed.hash.slice(1));
    } catch {
      // Raw credentials are accepted below.
    }
    return trimmed;
  }

  function setStatus(message: string, tone: "info" | "success" | "error" = "info"): void {
    if (!status) return;
    status.textContent = message;
    status.dataset.statusTone = tone;
  }

  async function checkIn(value: string): Promise<void> {
    const normalized = credential(value);
    if (!normalized || busy) return;
    const now = Date.now();
    if (normalized === lastCredential && now - lastCredentialAt < 1500) return;
    lastCredential = normalized;
    lastCredentialAt = now;
    busy = true;
    setStatus("正在检票……");
    const csrf = scannerRoot.querySelector<HTMLInputElement>("[name='csrfmiddlewaretoken']")?.value;
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          ...(csrf ? { "X-CSRFToken": csrf } : {}),
        },
        body: JSON.stringify({ credential: normalized }),
      });
      const payload = await response.json().catch(() => null) as { state?: string } | null;
      if (!response.ok) {
        setStatus("无效票据，或票据已作废。", "error");
      } else if (payload?.state === "checked_in") {
        setStatus("✓ 检票成功，可继续扫描下一张。", "success");
      } else {
        setStatus("票据状态已更新。", "success");
      }
    } catch {
      setStatus("网络暂时不可用，请重试。", "error");
    } finally {
      busy = false;
      if (input) input.value = "";
    }
  }

  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    void checkIn(input?.value || "");
  });

  if (!video) {
    setStatus("当前浏览器不支持摄像头，请使用下方手工输入。", "error");
    return;
  }
  const reader = new ZXingBrowser.BrowserQRCodeReader();
  void reader.decodeFromVideoDevice(undefined, video, (result) => {
    if (result) void checkIn(result.getText());
  }).catch(() => {
    setStatus("无法打开摄像头，请允许权限或使用下方手工输入。", "error");
  });
})();
