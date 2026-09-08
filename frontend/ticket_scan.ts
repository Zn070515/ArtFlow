(() => {
  "use strict";

  const redeemEndpoint = "/tickets/redeem/";
  const successMessage = "票据验证成功，可以继续投票。";
  const failureMessage = "票据验证失败，请重新扫描现场二维码。";

  function setStatus(status: HTMLElement | null, message: string): void {
    if (status) status.textContent = message;
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

  async function redeem(secret: string, status: HTMLElement | null): Promise<void> {
    try {
      const csrf = document.querySelector<HTMLInputElement>('[name="csrfmiddlewaretoken"]');
      const response = await fetch(redeemEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(csrf?.value ? { "X-CSRFToken": csrf.value } : {}),
        },
        body: JSON.stringify({ secret }),
      });
      setStatus(status, response.ok ? successMessage : failureMessage);
    } catch {
      setStatus(status, failureMessage);
    }
  }

  const root = document.querySelector<HTMLElement>("[data-ticket-scan-root]");
  if (!root) return;
  const status = document.querySelector<HTMLElement>("[data-ticket-scan-status]");
  const secret = readSecretFromFragment();
  if (!secret) {
    setStatus(status, "请扫描现场二维码。");
    return;
  }
  window.history.replaceState(null, "", window.location.pathname);
  void redeem(secret, status);
})();
