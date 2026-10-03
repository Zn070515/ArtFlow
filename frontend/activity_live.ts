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
  const ticketStatus = root.querySelector<HTMLElement>("[data-live-ticket-status]");

  // A fixed 2.5 s cadence made every open page poll in lockstep, so a whole
  // audience arrives as one spike. Jitter spreads the wave; the failure ladder
  // and the hidden-tab interval keep a struggling or backgrounded client from
  // spending the server's capacity on polls nobody is reading.
  const NORMAL_MIN_MS = 2200;
  const NORMAL_MAX_MS = 2800;
  const HIDDEN_MIN_MS = 10000;
  const HIDDEN_MAX_MS = 15000;
  const FAILURE_DELAYS_MS: readonly number[] = [2500, 5000, 8000, 10000];
  const MAX_FAILURE_DELAY_MS = 10000;

  let revision = "";
  let timer: number | undefined;
  let stopped = false;
  let pollInFlight = false;
  let failureCount = 0;

  function jitter(min: number, max: number): number {
    return min + Math.random() * (max - min);
  }

  function nextDelay(): number {
    if (document.hidden) return jitter(HIDDEN_MIN_MS, HIDDEN_MAX_MS);
    if (failureCount > 0) {
      return FAILURE_DELAYS_MS[Math.min(failureCount, FAILURE_DELAYS_MS.length) - 1]
        ?? MAX_FAILURE_DELAY_MS;
    }
    return jitter(NORMAL_MIN_MS, NORMAL_MAX_MS);
  }

  function schedule(): void {
    if (stopped) return;
    if (timer !== undefined) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = undefined;
      void poll();
    }, nextDelay());
  }

  function render(payload: unknown): void {
    if (!payload || typeof payload !== "object") return;
    const value = payload as {
      state?: unknown;
      label?: unknown;
      vote_name?: unknown;
      vote_url?: unknown;
      ticket_status?: unknown;
    };
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
    if (ticketStatus && typeof value.ticket_status === "string") {
      ticketStatus.textContent = value.ticket_status === "checked_in"
        ? "票券已检票，可以参与当前开放投票。"
        : value.ticket_status === "recognized"
          ? "票券已识别，请先到入口完成检票。"
          : "请先扫描入场票；完成检票后才能参与投票。";
    }
  }

  async function poll(): Promise<void> {
    if (stopped || pollInFlight) return;
    pollInFlight = true;
    try {
      const response = await fetch(endpoint, { credentials: "same-origin", cache: "no-store" });
      if (!response.ok) {
        failureCount += 1;
        return;
      }
      const payload = await response.json() as { revision?: unknown };
      if (typeof payload.revision === "string" && payload.revision !== revision) {
        revision = payload.revision;
        render(payload);
      }
      failureCount = 0;
    } catch {
      // Keep the server-rendered state and retry on the failure ladder.
      failureCount += 1;
    } finally {
      pollInFlight = false;
      schedule();
    }
  }

  document.addEventListener("visibilitychange", () => {
    if (stopped) return;
    if (document.hidden) {
      schedule();
      return;
    }
    // Back in view: refresh now instead of waiting out the hidden interval.
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timer = undefined;
    }
    void poll();
  });

  window.addEventListener("beforeunload", () => {
    stopped = true;
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timer = undefined;
    }
  });

  void poll();
})();
