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
    function setStatus(status, message, tone = "info") {
        if (!status)
            return;
        status.textContent = message;
        status.dataset.statusTone = tone;
        status.classList.remove("border-gray-200", "bg-gray-50", "text-gray-700", "border-green-200", "bg-green-50", "text-green-800", "border-red-200", "bg-red-50", "text-red-800");
        const classes = tone === "success"
            ? ["border-green-200", "bg-green-50", "text-green-800"]
            : tone === "error"
                ? ["border-red-200", "bg-red-50", "text-red-800"]
                : ["border-gray-200", "bg-gray-50", "text-gray-700"];
        status.classList.add(...classes);
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
            setStatus(status, response.ok ? ticketStateMessage(payload?.ticket_state) : failureMessage, response.ok ? "success" : "error");
        }
        catch {
            setStatus(status, failureMessage, "error");
        }
    }
    const root = document.querySelector("[data-ticket-scan-root]");
    if (!root)
        return;
    const status = document.querySelector("[data-ticket-scan-status]");
    const manualForm = root.querySelector("[data-ticket-manual-form]");
    const manualInput = root.querySelector("[name='secret']");
    const startRedeem = (secret, scrubFragment) => {
        const normalized = secret.trim();
        if (!normalized) {
            setStatus(status, "请输入票据码，或扫描现场二维码。", "error");
            return;
        }
        if (scrubFragment)
            window.history.replaceState(null, "", window.location.pathname);
        if (manualInput)
            manualInput.value = "";
        void redeem(normalized, status);
    };
    manualForm?.addEventListener("submit", (event) => {
        event.preventDefault();
        startRedeem(manualInput?.value || "", false);
    });
    const fragmentSecret = readSecretFromFragment();
    if (fragmentSecret) {
        startRedeem(fragmentSecret, true);
    }
    else {
        setStatus(status, "请扫描现场二维码，或输入票据码。");
    }
})();
