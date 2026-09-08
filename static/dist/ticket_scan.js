"use strict";
(() => {
    "use strict";
    const redeemEndpoint = "/tickets/redeem/";
    const successMessage = "票据验证成功，可以继续投票。";
    const failureMessage = "票据验证失败，请重新扫描现场二维码。";
    function setStatus(status, message) {
        if (status)
            status.textContent = message;
    }
    function readSecretFromFragment() {
        const fragment = window.location.hash.slice(1);
        if (!fragment)
            return "";
        try {
            return decodeURIComponent(fragment);
        }
        catch {
            return "";
        }
    }
    async function redeem(secret, status) {
        try {
            const response = await fetch(redeemEndpoint, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ secret }),
            });
            setStatus(status, response.ok ? successMessage : failureMessage);
        }
        catch {
            setStatus(status, failureMessage);
        }
    }
    const root = document.querySelector("[data-ticket-scan-root]");
    if (!root)
        return;
    const status = document.querySelector("[data-ticket-scan-status]");
    const secret = readSecretFromFragment();
    if (!secret) {
        setStatus(status, "请扫描现场二维码。");
        return;
    }
    window.history.replaceState(null, "", window.location.pathname);
    void redeem(secret, status);
})();
