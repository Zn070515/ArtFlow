"use strict";
(() => {
    "use strict";
    const root = document.querySelector("[data-activity-field-editor]");
    if (!root)
        return;
    const csrfToken = root.querySelector("[name='csrfmiddlewaretoken']")?.value ?? "";
    const states = new WeakMap();
    const DEBOUNCE_MS = 800;
    function rowParts(row) {
        const input = row.querySelector("[data-activity-field-input]");
        const status = row.querySelector("[data-activity-field-status]");
        const save = row.querySelector("[data-activity-field-save]");
        const useRemote = row.querySelector("[data-activity-field-use-remote]");
        const force = row.querySelector("[data-activity-field-force]");
        if (!input || !status || !save || !useRemote || !force)
            return null;
        return { input, status, save, useRemote, force };
    }
    function stateFor(row, input) {
        const existing = states.get(row);
        if (existing)
            return existing;
        const state = { base: input.value, inFlight: false, queued: false };
        states.set(row, state);
        return state;
    }
    function setStatus(status, text, className) {
        status.textContent = text;
        status.className = className;
    }
    // Local durability, the same shape the questionnaire form uses. An operator editing on a
    // venue phone lost whatever was typed but not yet saved the moment the page reloaded or
    // the browser was killed — the debounce is 800 ms and the PATCH can fail on the venue's
    // wifi. The text now lives in localStorage keyed by the field, so a reload restores it and
    // re-sends it; `state.base` still holds the value the *server* rendered, which is what the
    // compare-and-set has to declare.
    const DRAFT_STORAGE_KEY = `artflow:activity-fields:${window.location.pathname}`;
    function fieldKey(input) {
        return input.dataset.activityField || input.name || input.id || "field";
    }
    function draftStore() {
        try {
            return window.localStorage || null;
        }
        catch {
            return null;
        }
    }
    function readDrafts() {
        const raw = draftStore()?.getItem(DRAFT_STORAGE_KEY);
        if (!raw)
            return {};
        try {
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
                return {};
            return parsed;
        }
        catch {
            return {};
        }
    }
    function writeDrafts(drafts) {
        const store = draftStore();
        if (!store)
            return;
        if (Object.keys(drafts).length === 0)
            store.removeItem(DRAFT_STORAGE_KEY);
        else
            store.setItem(DRAFT_STORAGE_KEY, JSON.stringify(drafts));
    }
    function stashDraft(input, state) {
        const drafts = readDrafts();
        const key = fieldKey(input);
        if (input.value === state.base)
            delete drafts[key];
        else
            drafts[key] = input.value;
        writeDrafts(drafts);
    }
    function restoreDrafts() {
        const drafts = readDrafts();
        if (Object.keys(drafts).length === 0)
            return;
        const scope = root;
        if (!scope)
            return;
        for (const row of scope.querySelectorAll("[data-activity-field-row]")) {
            const parts = rowParts(row);
            if (!parts)
                continue;
            const value = drafts[fieldKey(parts.input)];
            if (value === undefined || value === parts.input.value)
                continue;
            parts.input.value = value;
            setStatus(parts.status, "已恢复未保存的修改", "text-amber-700");
            schedule(row);
        }
    }
    function clearConflict(parts) {
        if (!parts)
            return;
        parts.useRemote.hidden = true;
        parts.force.hidden = true;
    }
    function schedule(row, immediate = false) {
        const parts = rowParts(row);
        if (!parts)
            return;
        const state = stateFor(row, parts.input);
        if (state.timer !== undefined)
            window.clearTimeout(state.timer);
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
    async function save(row, force = false) {
        const parts = rowParts(row);
        if (!parts)
            return;
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
            stashDraft(parts.input, state);
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
            const payload = await response.json();
            if (response.status === 409 && typeof payload.value === "string") {
                state.remoteValue = payload.value;
                parts.useRemote.hidden = false;
                parts.force.hidden = false;
                setStatus(parts.status, "发生冲突，请选择版本", "text-amber-700");
            }
            else if (!response.ok) {
                setStatus(parts.status, typeof payload.detail === "string" ? payload.detail : "保存失败，请稍后重试。", "text-red-700");
            }
            else if (typeof payload.value === "string") {
                state.base = payload.value;
                state.remoteValue = undefined;
                clearConflict(parts);
                if (parts.input.value === sentValue)
                    parts.input.value = payload.value;
                stashDraft(parts.input, state);
                setStatus(parts.status, "已保存", "text-green-700");
                if (parts.input.value !== state.base)
                    schedule(row);
            }
            else {
                setStatus(parts.status, "服务器返回无效结果。", "text-red-700");
            }
        }
        catch {
            setStatus(parts.status, "网络错误，修改仍保留在当前页面。", "text-amber-700");
        }
        finally {
            state.inFlight = false;
            parts.save.disabled = false;
            if (state.queued) {
                state.queued = false;
                schedule(row);
            }
        }
    }
    for (const row of root.querySelectorAll("[data-activity-field-row]")) {
        const parts = rowParts(row);
        if (!parts)
            continue;
        stateFor(row, parts.input);
        parts.input.addEventListener("input", () => {
            stashDraft(parts.input, stateFor(row, parts.input));
            schedule(row);
        });
        parts.input.addEventListener("blur", () => {
            stashDraft(parts.input, stateFor(row, parts.input));
            schedule(row, true);
        });
        parts.save.addEventListener("click", () => schedule(row, true));
        parts.useRemote.addEventListener("click", () => {
            const state = stateFor(row, parts.input);
            if (state.remoteValue === undefined)
                return;
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
    restoreDrafts();
    root.addEventListener("submit", (event) => event.preventDefault());
})();
