(() => {
  "use strict";

  const root = document.querySelector<HTMLFormElement>("[data-activity-field-editor]");
  if (!root) return;

  type FieldInput = HTMLInputElement | HTMLTextAreaElement;
  type FieldState = {
    base: string;
    remoteValue?: string;
    timer?: number;
    inFlight: boolean;
    queued: boolean;
  };

  const csrfToken = root.querySelector<HTMLInputElement>("[name='csrfmiddlewaretoken']")?.value ?? "";
  const states = new WeakMap<HTMLElement, FieldState>();
  const DEBOUNCE_MS = 800;

  function rowParts(row: HTMLElement): {
    input: FieldInput;
    status: HTMLElement;
    save: HTMLButtonElement;
    useRemote: HTMLButtonElement;
    force: HTMLButtonElement;
  } | null {
    const input = row.querySelector<FieldInput>("[data-activity-field-input]");
    const status = row.querySelector<HTMLElement>("[data-activity-field-status]");
    const save = row.querySelector<HTMLButtonElement>("[data-activity-field-save]");
    const useRemote = row.querySelector<HTMLButtonElement>("[data-activity-field-use-remote]");
    const force = row.querySelector<HTMLButtonElement>("[data-activity-field-force]");
    if (!input || !status || !save || !useRemote || !force) return null;
    return { input, status, save, useRemote, force };
  }

  function stateFor(row: HTMLElement, input: FieldInput): FieldState {
    const existing = states.get(row);
    if (existing) return existing;
    const state: FieldState = { base: input.value, inFlight: false, queued: false };
    states.set(row, state);
    return state;
  }

  function setStatus(status: HTMLElement, text: string, className: string): void {
    status.textContent = text;
    status.className = className;
  }

  function clearConflict(parts: ReturnType<typeof rowParts>): void {
    if (!parts) return;
    parts.useRemote.hidden = true;
    parts.force.hidden = true;
  }

  function schedule(row: HTMLElement, immediate = false): void {
    const parts = rowParts(row);
    if (!parts) return;
    const state = stateFor(row, parts.input);
    if (state.timer !== undefined) window.clearTimeout(state.timer);
    if (immediate) {
      state.timer = undefined;
      void save(row);
      return;
    }
    state.timer = window.setTimeout(() => {
      state.timer = undefined;
      void save(row);
    }, DEBOUNCE_MS);
  }

  async function save(row: HTMLElement, force = false): Promise<void> {
    const parts = rowParts(row);
    if (!parts) return;
    const state = stateFor(row, parts.input);
    if (state.inFlight) {
      state.queued = true;
      return;
    }

    const value = parts.input.value;
    const base = force && state.remoteValue !== undefined ? state.remoteValue : state.base;
    if (value === base) {
      state.base = base;
      state.remoteValue = undefined;
      clearConflict(parts);
      setStatus(parts.status, "已同步", "text-gray-500");
      return;
    }

    state.inFlight = true;
    parts.save.disabled = true;
    setStatus(parts.status, "保存中…", "text-gray-500");
    const sentValue = value;
    try {
      const response = await fetch(parts.input.dataset.activityPatchUrl ?? "", {
        method: "PATCH",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "X-CSRFToken": csrfToken,
        },
        body: JSON.stringify({ base, value: sentValue }),
      });
      const payload = await response.json() as { detail?: unknown; value?: unknown };
      if (response.status === 409 && typeof payload.value === "string") {
        state.remoteValue = payload.value;
        parts.useRemote.hidden = false;
        parts.force.hidden = false;
        setStatus(parts.status, "发生冲突，请选择版本", "text-amber-700");
      } else if (!response.ok) {
        setStatus(
          parts.status,
          typeof payload.detail === "string" ? payload.detail : "保存失败，请稍后重试。",
          "text-red-700",
        );
      } else if (typeof payload.value === "string") {
        state.base = payload.value;
        state.remoteValue = undefined;
        clearConflict(parts);
        if (parts.input.value === sentValue) parts.input.value = payload.value;
        setStatus(parts.status, "已保存", "text-green-700");
        if (parts.input.value !== state.base) schedule(row);
      } else {
        setStatus(parts.status, "服务器返回无效结果。", "text-red-700");
      }
    } catch {
      setStatus(parts.status, "网络错误，修改仍保留在当前页面。", "text-amber-700");
    } finally {
      state.inFlight = false;
      parts.save.disabled = false;
      if (state.queued) {
        state.queued = false;
        schedule(row);
      }
    }
  }

  for (const row of root.querySelectorAll<HTMLElement>("[data-activity-field-row]")) {
    const parts = rowParts(row);
    if (!parts) continue;
    stateFor(row, parts.input);
    parts.input.addEventListener("input", () => schedule(row));
    parts.input.addEventListener("blur", () => schedule(row, true));
    parts.save.addEventListener("click", () => schedule(row, true));
    parts.useRemote.addEventListener("click", () => {
      const state = stateFor(row, parts.input);
      if (state.remoteValue === undefined) return;
      parts.input.value = state.remoteValue;
      state.base = state.remoteValue;
      state.remoteValue = undefined;
      clearConflict(parts);
      setStatus(parts.status, "已载入服务器版本", "text-gray-500");
    });
    parts.force.addEventListener("click", () => {
      void save(row, true);
    });
  }

  root.addEventListener("submit", (event) => event.preventDefault());
})();
