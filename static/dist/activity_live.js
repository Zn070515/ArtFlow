"use strict";
(() => {
    "use strict";
    const root = document.querySelector("[data-live-surface]");
    if (!root)
        return;
    const stateUrl = root.dataset.stateUrl;
    if (!stateUrl)
        return;
    const endpoint = stateUrl;
    const voteSection = root.querySelector("[data-live-vote-section]");
    const waitingSection = root.querySelector("[data-live-waiting]");
    const voteName = root.querySelector("[data-live-vote-name]");
    const voteLabel = root.querySelector("[data-live-vote-label]");
    const voteLink = root.querySelector("[data-live-vote-link]");
    const ticketStatus = root.querySelector("[data-live-ticket-status]");
    let revision = "";
    let timer;
    function render(payload) {
        if (!payload || typeof payload !== "object")
            return;
        const value = payload;
        if (typeof value.state !== "string" || typeof value.label !== "string" || typeof value.vote_name !== "string")
            return;
        const open = value.state === "open" && typeof value.vote_url === "string" && value.vote_url.length > 0;
        if (voteSection && waitingSection) {
            voteSection.classList.toggle("hidden", !value.vote_name);
            waitingSection.classList.toggle("hidden", Boolean(value.vote_name));
        }
        if (voteName)
            voteName.textContent = value.vote_name;
        if (voteLabel)
            voteLabel.textContent = value.label;
        if (voteLink) {
            voteLink.href = typeof value.vote_url === "string" ? value.vote_url : "#";
            voteLink.classList.toggle("hidden", !open);
        }
        if (ticketStatus && typeof value.ticket_status === "string") {
            ticketStatus.textContent = value.ticket_status === "checked_in"
                ? "票券已检票，可以参与当前开放投票。"
                : value.ticket_status === "recognized"
                    ? "票券已识别，请先到入口完成检票。"
                    : "请先扫描入场票；完成检票后才能参与投票。";
        }
    }
    async function poll() {
        try {
            const response = await fetch(endpoint, { credentials: "same-origin", cache: "no-store" });
            if (response.ok) {
                const payload = await response.json();
                if (typeof payload.revision === "string" && payload.revision !== revision) {
                    revision = payload.revision;
                    render(payload);
                }
            }
        }
        catch {
            // Keep the server-rendered state while the next poll retries.
        }
        finally {
            timer = window.setTimeout(() => void poll(), 2500);
        }
    }
    void poll();
    window.addEventListener("beforeunload", () => {
        if (timer !== undefined)
            window.clearTimeout(timer);
    });
})();
