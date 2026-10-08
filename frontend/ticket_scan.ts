(() => {
  "use strict";

  const redeemEndpoint = "/tickets/redeem/";
  const failureMessage = "票据验证失败，请重新扫描现场二维码。";

  function ticketStateMessage(ticketState: unknown): string {
    if (ticketState === "issued") {
      return "票据已识别。完成现场检票后获得投票资格。";
    }
    if (ticketState === "checked_in") {
      return "已完成现场检票。你已具备票券投票资格，具体以当前投票场次状态为准。";
    }
    return failureMessage;
  }

  function setStatus(
    status: HTMLElement | null,
    message: string,
    tone: "info" | "success" | "error" = "info",
  ): void {
    if (!status) return;
    status.textContent = message;
    status.dataset.statusTone = tone;
    status.classList.remove(
      "border-gray-200", "bg-gray-50", "text-gray-700",
      "border-green-200", "bg-green-50", "text-green-800",
      "border-red-200", "bg-red-50", "text-red-800",
    );
    const classes = tone === "success"
      ? ["border-green-200", "bg-green-50", "text-green-800"]
      : tone === "error"
        ? ["border-red-200", "bg-red-50", "text-red-800"]
        : ["border-gray-200", "bg-gray-50", "text-gray-700"];
    status.classList.add(...classes);
  }

  function readSecretFromFragment(): string {
    const fragment = window.location.hash.slice(1);
    if (!fragment) return "";
    try {
      return decodeURIComponent(fragment);
    } catch {
      return "";
    }
  }

  function normalizeCredential(value: string): string {
    const trimmed = value.trim();
    if (!trimmed) return "";
    try {
      const parsed = new URL(trimmed, window.location.origin);
      if (parsed.hash) return decodeURIComponent(parsed.hash.slice(1));
    } catch {
      // Raw credential fallback.
    }
    return trimmed;
  }

  // The scanned credential, held in memory only. The fragment is scrubbed from the URL
  // before the request (it is a bearer secret, and the address bar ends up in screenshots
  // and history), but scrubbing it *only* there meant a dropped request on venue wifi left
  // the viewer with nothing to retry — they had to walk back to the poster and re-scan.
  let lastCredential = "";

  async function redeem(secret: string, status: HTMLElement | null): Promise<void> {
    const credential = normalizeCredential(secret);
    try {
      const csrf = document.querySelector<HTMLInputElement>('[name="csrfmiddlewaretoken"]');
      const response = await fetch(redeemEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(csrf?.value ? { "X-CSRFToken": csrf.value } : {}),
        },
        body: JSON.stringify({ secret: credential }),
      });
      if (!response.ok) {
        // The server answered: re-sending the same code will not change its mind.
        lastCredential = "";
        setRetryVisible(false);
        setStatus(status, failureMessage, "error");
        return;
      }
      const payload = await response.json();
      lastCredential = "";
      setRetryVisible(false);
      setStatus(status, ticketStateMessage(payload?.ticket_state), "success");
    } catch {
      // A network failure, not a rejection: keep the credential so the retry button (or a
      // second attempt) does not need the QR again.
      lastCredential = credential;
      setRetryVisible(true);
      setStatus(status, "网络暂时不可用，请重试。", "error");
    }
  }

  function setRetryVisible(visible: boolean): void {
    if (!retryButton) return;
    retryButton.classList.toggle("hidden", !visible);
  }

  const root = document.querySelector<HTMLElement>("[data-ticket-scan-root]");
  if (!root) return;
  const status = document.querySelector<HTMLElement>("[data-ticket-scan-status]");
  const manualForm = root.querySelector<HTMLFormElement>("[data-ticket-manual-form]");
  const manualInput = root.querySelector<HTMLInputElement>("[name='secret']");
  const retryButton = root.querySelector<HTMLButtonElement>("[data-ticket-scan-retry]");
  retryButton?.addEventListener("click", () => {
    if (lastCredential) void redeem(lastCredential, status);
  });

  const startRedeem = (secret: string, scrubFragment: boolean): void => {
    const normalized = secret.trim();
    if (!normalized) {
      setStatus(status, "请输入票据码，或扫描现场二维码。", "error");
      return;
    }
    if (scrubFragment) window.history.replaceState(null, "", window.location.pathname);
    if (manualInput) manualInput.value = "";
    void redeem(normalized, status);
  };

  manualForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    startRedeem(manualInput?.value || "", false);
  });

  const fragmentSecret = readSecretFromFragment();
  if (fragmentSecret) {
    startRedeem(fragmentSecret, true);
  } else {
    setStatus(status, "请扫描现场二维码，或输入票据码。");
  }
})();
