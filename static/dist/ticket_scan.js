"use strict";
(() => {
    "use strict";
    const redeemEndpoint = "/tickets/redeem/";
    const failureMessage = "票据验证失败，请重新扫描现场二维码。";
    function ticketStateMessage(ticketState) {
        if (ticketState === "issued") {
            return "票据已识别。完成现场检票后获得投票资格。";
        }
        if (ticketState === "checked_in") {
            return "已完成现场检票。你已具备票券投票资格，具体以当前投票场次状态为准。";
        }
        return failureMessage;
    }
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
            const csrf = document.querySelector('[name="csrfmiddlewaretoken"]');
            const response = await fetch(redeemEndpoint, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    ...(csrf?.value ? { "X-CSRFToken": csrf.value } : {}),
                },
                body: JSON.stringify({ secret }),
            });
            const payload = response.ok ? await response.json() : null;
            setStatus(status, response.ok ? ticketStateMessage(payload?.ticket_state) : failureMessage);
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
