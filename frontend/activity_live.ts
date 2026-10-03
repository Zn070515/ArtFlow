(() => {
  "use strict";

  const root = document.querySelector<HTMLElement>("[data-live-surface]");
  if (!root) return;
  const stateUrl = root.dataset.stateUrl;
  if (!stateUrl) return;
  const endpoint = stateUrl;
  const voteSection = root.querySelector<HTMLElement>("[data-live-vote-section]");
  const waitingSection = root.querySelector<HTMLElement>("[data-live-waiting]");
  const voteName = root.querySelector<HTMLElement>("[data-live-vote-name]");
  const voteLabel = root.querySelector<HTMLElement>("[data-live-vote-label]");
  const voteLink = root.querySelector<HTMLAnchorElement>("[data-live-vote-link]");
  let revision = "";
  let timer: number | undefined;

  function render(payload: unknown): void {
    if (!payload || typeof payload !== "object") return;
    const value = payload as { state?: unknown; label?: unknown; vote_name?: unknown; vote_url?: unknown };
    if (typeof value.state !== "string" || typeof value.label !== "string" || typeof value.vote_name !== "string") return;
    const open = value.state === "open" && typeof value.vote_url === "string" && value.vote_url.length > 0;
    if (voteSection && waitingSection) {
      voteSection.classList.toggle("hidden", !value.vote_name);
      waitingSection.classList.toggle("hidden", Boolean(value.vote_name));
    }
    if (voteName) voteName.textContent = value.vote_name;
    if (voteLabel) voteLabel.textContent = value.label;
    if (voteLink) {
      voteLink.href = typeof value.vote_url === "string" ? value.vote_url : "#";
      voteLink.classList.toggle("hidden", !open);
    }
  }

  async function poll(): Promise<void> {
    try {
      const response = await fetch(endpoint, { credentials: "same-origin", cache: "no-store" });
      if (response.ok) {
        const payload = await response.json() as { revision?: unknown };
        if (typeof payload.revision === "string" && payload.revision !== revision) {
          revision = payload.revision;
          render(payload);
        }
      }
    } catch {
      // Keep the server-rendered state while the next poll retries.
    } finally {
      timer = window.setTimeout(() => void poll(), 2500);
    }
  }

  void poll();
  window.addEventListener("beforeunload", () => {
    if (timer !== undefined) window.clearTimeout(timer);
  });
})();
