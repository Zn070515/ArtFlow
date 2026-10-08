declare const ZXingBrowser: {
  BrowserQRCodeReader: new () => {
    decodeFromVideoDevice(
      deviceId: string | undefined,
      video: HTMLVideoElement,
      callback: (result: { getText(): string } | undefined) => void,
    ): Promise<unknown>;
    decodeFromImageUrl(url?: string): Promise<{ getText(): string }>;
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

  function setStatus(
    message: string,
    tone: "info" | "success" | "warn" | "error" = "info",
  ): void {
    if (!status) return;
    status.textContent = message;
    status.dataset.statusTone = tone;
  }

  /** " 19:04 已检票" when the server told us when, "" otherwise. */
  function checkedInLabel(value: string | null | undefined): string {
    if (!value) return "";
    const at = new Date(value);
    if (Number.isNaN(at.getTime())) return "";
    const pad = (n: number): string => String(n).padStart(2, "0");
    return ` ${pad(at.getHours())}:${pad(at.getMinutes())} 已检票`;
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
      const payload = await response.json().catch(() => null) as {
        state?: string;
        already_checked_in?: boolean;
        checked_in_at?: string | null;
      } | null;
      if (!response.ok) {
        setStatus("无效票据，或票据已作废。", "error");
      } else if (payload?.already_checked_in) {
        // GOAL §10.3 asks the door for 成功 / 已检票 / 无效. An idempotent repeat is a
        // different fact from a fresh admit, and calling it a success let one ticket be
        // walked past two scanners without anyone noticing.
        setStatus(`⚠ 该票此前已检票${checkedInLabel(payload.checked_in_at)}，本次未重复计入。`, "warn");
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

  const photoFallback = root.querySelector<HTMLElement>("[data-ticket-photo-fallback]");
  const photoInput = root.querySelector<HTMLInputElement>("[data-ticket-photo]");

  const offerPhotoFallback = (message: string, tone: "info" | "error"): void => {
    photoFallback?.classList.remove("hidden");
    setStatus(message, tone);
  };

  // Scanning a still photo. `getUserMedia` only exists in a secure context, so on the
  // no-ICP LAN fallback (`http://192.168.x.x:8000`) it is not merely refused — the API is
  // absent and there is no error to catch. A file input with `capture` goes through the
  // system camera app instead, which no secure-context rule restricts, and ZXing decodes
  // the still image the same way.
  photoInput?.addEventListener("change", () => {
    const file = photoInput.files && photoInput.files[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    const reader = new ZXingBrowser.BrowserQRCodeReader();
    setStatus("正在识别照片……");
    void reader
      .decodeFromImageUrl(url)
      .then((result) => checkIn(result.getText()))
      .catch(() => {
        setStatus("照片里没有识别到二维码，请对准二维码重拍，或手工输入票据码。", "error");
      })
      .finally(() => {
        URL.revokeObjectURL(url);
        photoInput.value = "";
      });
  });

  if (!navigator.mediaDevices?.getUserMedia) {
    offerPhotoFallback(
      "当前页面不是 HTTPS，浏览器不提供实时摄像头。请拍一张二维码照片，或手工输入票据码。",
      "info",
    );
    return;
  }

  if (!video) {
    offerPhotoFallback("当前浏览器不支持实时摄像头，请拍照识别或手工输入。", "error");
    return;
  }
  const reader = new ZXingBrowser.BrowserQRCodeReader();
  void reader.decodeFromVideoDevice(undefined, video, (result) => {
    if (result) void checkIn(result.getText());
  }).catch(() => {
    offerPhotoFallback("无法打开摄像头，请拍照识别或手工输入。", "error");
  });
})();
