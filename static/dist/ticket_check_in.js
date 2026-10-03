import { BrowserQRCodeReader } from "@zxing/browser";
(() => {
    "use strict";
    const root = document.querySelector("[data-ticket-check-in-root]");
    if (!root)
        return;
    const scannerRoot = root;
    const video = root.querySelector("[data-ticket-camera]");
    const status = root.querySelector("[data-ticket-check-in-status]");
    const form = root.querySelector("[data-ticket-check-in-form]");
    const input = root.querySelector("[name='secret']");
    const endpoint = root.dataset.checkInUrl || "/staff/tickets/check-in/";
    let busy = false;
    let lastCredential = "";
    let lastCredentialAt = 0;
    function credential(value) {
        const trimmed = value.trim();
        if (!trimmed)
            return "";
        try {
            const parsed = new URL(trimmed, window.location.origin);
            if (parsed.hash)
                return decodeURIComponent(parsed.hash.slice(1));
        }
        catch {
            // Raw credentials are accepted below.
        }
        return trimmed;
    }
    function setStatus(message, tone = "info") {
        if (!status)
            return;
        status.textContent = message;
        status.dataset.statusTone = tone;
    }
    async function checkIn(value) {
        const normalized = credential(value);
        if (!normalized || busy)
            return;
        const now = Date.now();
        if (normalized === lastCredential && now - lastCredentialAt < 1500)
            return;
        lastCredential = normalized;
        lastCredentialAt = now;
        busy = true;
        setStatus("正在检票……");
        const csrf = scannerRoot.querySelector("[name='csrfmiddlewaretoken']")?.value;
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
            const payload = await response.json().catch(() => null);
            if (!response.ok) {
                setStatus("无效票据，或票据已作废。", "error");
            }
            else if (payload?.state === "checked_in") {
                setStatus("✓ 检票成功，可继续扫描下一张。", "success");
            }
            else {
                setStatus("票据状态已更新。", "success");
            }
        }
        catch {
            setStatus("网络暂时不可用，请重试。", "error");
        }
        finally {
            busy = false;
            if (input)
                input.value = "";
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
    const reader = new BrowserQRCodeReader();
    void reader.decodeFromVideoDevice(undefined, video, (result) => {
        if (result)
            void checkIn(result.getText());
    }).catch(() => {
        setStatus("无法打开摄像头，请允许权限或使用下方手工输入。", "error");
    });
})();
