"use strict";
(function () {
    "use strict";
    function isRecord(value) {
        return typeof value === "object" && value !== null;
    }
    function isPositiveInteger(value) {
        return typeof value === "number" && Number.isInteger(value) && value > 0;
    }
    function isNonNegativeInteger(value) {
        return typeof value === "number" && Number.isInteger(value) && value >= 0;
    }
    function validScoreOrEmpty(value) {
        return typeof value === "string" && (value === "" || scoreState(value) === "valid");
    }
    function parseGrid(value) {
        if (!Array.isArray(value))
            return [];
        return value.flatMap((rowValue) => {
            if (!isRecord(rowValue) || !isPositiveInteger(rowValue.singer_id) || !Array.isArray(rowValue.cells)) {
                return [];
            }
            const cells = rowValue.cells.flatMap((cellValue) => {
                if (!isRecord(cellValue) || !isPositiveInteger(cellValue.judge_id))
                    return [];
                return [{
                        judge_id: cellValue.judge_id,
                        judge_name: typeof cellValue.judge_name === "string" ? cellValue.judge_name : undefined,
                        score: typeof cellValue.score === "string" ? cellValue.score : "",
                    }];
            });
            return [{
                    singer_id: rowValue.singer_id,
                    singer_name: typeof rowValue.singer_name === "string" ? rowValue.singer_name : undefined,
                    song: typeof rowValue.song === "string" ? rowValue.song : undefined,
                    cells,
                }];
        });
    }
    function parseGridResponse(value) {
        if (!isRecord(value) || !isNonNegativeInteger(value.version))
            return null;
        return {
            version: value.version,
            grid: parseGrid(value.grid),
            matrix_complete: value.matrix_complete === true,
            resolved_status: typeof value.resolved_status === "string" ? value.resolved_status : null,
        };
    }
    function parseSaveResponse(value) {
        if (!isRecord(value) || !isNonNegativeInteger(value.version))
            return null;
        return {
            version: value.version,
            matrix_complete: value.matrix_complete === true,
            resolved_status: typeof value.resolved_status === "string" ? value.resolved_status : null,
        };
    }
    function readInitial(dataEl) {
        if (!dataEl)
            return { version: 0, grid: [] };
        try {
            const parsed = JSON.parse(dataEl.textContent || "{}");
            if (!isRecord(parsed))
                return { version: 0, grid: [] };
            const version = isNonNegativeInteger(parsed.version) ? parsed.version : 0;
            return {
                version,
                grid: parseGrid(parsed.grid),
            };
        }
        catch (_error) {
            return { version: 0, grid: [] };
        }
    }
    const container = document.getElementById("rapid-entry");
    if (!container)
        return;
    const operatorId = container.dataset.operatorId || "";
    if (!/^[1-9]\d*$/.test(operatorId))
        return;
    const apiUrl = container.dataset.apiUrl || "";
    const activityId = parseInt(container.dataset.activityId || "", 10);
    const roundId = parseInt(container.dataset.roundId || "", 10);
    const locked = container.dataset.locked === "true";
    const csrf = document.querySelector('[name="csrfmiddlewaretoken"]');
    const csrfToken = csrf ? csrf.value : "";
    const dataEl = document.getElementById("rapid-grid-data");
    const initial = readInitial(dataEl);
    const tbody = container.querySelector("tbody");
    const progressFill = container.querySelector("[data-progress-fill]");
    const progressText = container.querySelector("[data-progress-text]");
    const versionEl = container.querySelector("[data-version]");
    const resolvedEl = container.querySelector("[data-resolved]");
    const errorBox = container.querySelector("[data-error]");
    const retryButton = container.querySelector("[data-retry]");
    const pendingCountEl = container.querySelector("[data-pending-count]");
    const savedCountEl = container.querySelector("[data-saved-count]");
    const conflictsEl = container.querySelector("[data-conflicts]");
    const pendingStorageKey = "artflow:rapid-score:pending:" +
        activityId +
        ":" +
        roundId +
        ":" +
        operatorId +
        ":" +
        apiUrl;
    const state = {
        version: initial.version,
        cells: {},
        dirty: {},
        total: 0,
        filled: 0,
        locked,
        draftCommandId: null,
        draftBaseVersion: null,
        conflicts: {},
    };
    function key(singerId, judgeId) {
        return singerId + ":" + judgeId;
    }
    function initCells(grid) {
        state.cells = {};
        grid.forEach((row) => {
            row.cells.forEach((cell) => {
                state.cells[key(row.singer_id, cell.judge_id)] = cell.score || "";
            });
        });
        state.total = Object.keys(state.cells).length;
    }
    function inputFor(singerId, judgeId) {
        if (!tbody)
            return null;
        return tbody.querySelector('input[data-singer-id="' + singerId + '"][data-judge-id="' + judgeId + '"]');
    }
    function asInputElement(value) {
        if (!value || typeof value !== "object")
            return null;
        const candidate = value;
        return typeof candidate.value === "string" && candidate.dataset !== undefined
            ? value
            : null;
    }
    function recountFilled() {
        let filled = 0;
        for (const cellKey in state.cells) {
            if (state.cells[cellKey] !== "")
                filled++;
        }
        state.filled = filled;
    }
    function updateProgress() {
        recountFilled();
        const pct = state.total ? Math.round((state.filled / state.total) * 100) : 0;
        if (progressFill)
            progressFill.style.width = pct + "%";
        if (progressText)
            progressText.textContent = state.filled + " / " + state.total;
        if (savedCountEl)
            savedCountEl.textContent = String(state.filled);
    }
    function updatePendingCount() {
        if (pendingCountEl)
            pendingCountEl.textContent = String(Object.keys(state.dirty).length);
    }
    function setVersion(version) {
        state.version = version;
        if (versionEl)
            versionEl.textContent = "#" + version;
    }
    function setResolved(status) {
        if (resolvedEl)
            resolvedEl.textContent = status || "未计算";
    }
    function showError(message) {
        if (!errorBox)
            return;
        errorBox.textContent = message;
        errorBox.classList.remove("hidden");
    }
    function clearError() {
        if (!errorBox)
            return;
        errorBox.textContent = "";
        errorBox.classList.add("hidden");
    }
    function renderConflicts() {
        const conflictKeys = Object.keys(state.conflicts);
        if (!conflictsEl)
            return;
        if (!conflictKeys.length) {
            conflictsEl.textContent = "";
            conflictsEl.classList.add("hidden");
            return;
        }
        conflictsEl.textContent = conflictKeys.flatMap((conflictKey) => {
            const conflict = state.conflicts[conflictKey];
            if (!conflict)
                return [];
            return ["选手 " + conflict.singer_id + "、评委 " + conflict.judge_id +
                    "：服务器为 " + conflict.server + "，本机草稿为 " + conflict.local +
                    "。请修改该单元格后再重试保存，以明确选择。"];
        }).join(" ");
        conflictsEl.classList.remove("hidden");
    }
    const SCORE_RE = /^\s*\d{1,3}(\.\d{1,2})?\s*$/;
    function scoreState(value) {
        const trimmed = value.trim();
        if (trimmed === "")
            return "empty";
        if (!SCORE_RE.test(trimmed))
            return "invalid";
        const numberValue = parseFloat(trimmed);
        if (numberValue < 0 || numberValue > 100)
            return "invalid";
        return "valid";
    }
    function setVisual(input, bad) {
        input.style.borderColor = bad ? "#ef4444" : "#d1d5db";
        input.style.boxShadow = bad ? "0 0 0 1px #ef4444" : "none";
        input.style.background = bad ? "#fef2f2" : "";
    }
    function onInput(event) {
        const input = asInputElement(event.target);
        if (!input || state.locked || input.disabled)
            return;
        const value = input.value;
        const status = scoreState(value);
        if (status === "invalid") {
            setVisual(input, true);
            return;
        }
        setVisual(input, false);
        const cellKey = key(input.dataset.singerId || "", input.dataset.judgeId || "");
        if (status === "empty") {
            delete state.dirty[cellKey];
            delete state.conflicts[cellKey];
            persistDraft();
            updatePendingCount();
            renderConflicts();
            scheduleSave();
            return;
        }
        state.dirty[cellKey] = value.trim();
        delete state.conflicts[cellKey];
        state.draftCommandId = newCommandId();
        state.draftBaseVersion = state.version;
        persistDraft();
        updatePendingCount();
        renderConflicts();
        scheduleSave();
    }
    let saveTimer = null;
    let retryTimer = null;
    let retryAttempt = 0;
    let saveInflight = false;
    function newCommandId() {
        if (window.crypto && typeof window.crypto.randomUUID === "function") {
            return "rapid-" + window.crypto.randomUUID();
        }
        return "rapid-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 14);
    }
    function localStorageOrNull() {
        try {
            return window.localStorage || null;
        }
        catch (_error) {
            return null;
        }
    }
    function cellsFromDirty() {
        return Object.keys(state.dirty).sort().flatMap((cellKey) => {
            const [singerPart, judgePart] = cellKey.split(":");
            const score = state.dirty[cellKey];
            if (singerPart === undefined || judgePart === undefined || score === undefined)
                return [];
            return [{
                    singer_id: parseInt(singerPart, 10),
                    judge_id: parseInt(judgePart, 10),
                    score,
                }];
        });
    }
    function validPendingCells(cells) {
        return Array.isArray(cells) && cells.length > 0 && cells.every((cell) => {
            return isRecord(cell) && isPositiveInteger(cell.singer_id) &&
                isPositiveInteger(cell.judge_id) && typeof cell.score === "string" &&
                scoreState(cell.score) === "valid";
        });
    }
    function conflictRecords(cells) {
        const pendingByKey = {};
        cells.forEach((cell) => {
            pendingByKey[key(cell.singer_id, cell.judge_id)] = cell.score;
        });
        const records = [];
        for (const cellKey of Object.keys(state.conflicts).sort()) {
            const conflict = state.conflicts[cellKey];
            const local = pendingByKey[cellKey];
            if (!conflict || local === undefined)
                return null;
            records.push({
                singer_id: conflict.singer_id,
                judge_id: conflict.judge_id,
                base: conflict.base,
                server: conflict.server,
                local,
            });
        }
        return records;
    }
    function validPendingConflicts(conflicts, cells) {
        if (conflicts === undefined)
            return true;
        if (!Array.isArray(conflicts))
            return false;
        const pendingByKey = {};
        cells.forEach((cell) => {
            pendingByKey[key(cell.singer_id, cell.judge_id)] = cell.score;
        });
        const seen = {};
        return conflicts.every((conflict) => {
            if (!isRecord(conflict) || !isPositiveInteger(conflict.singer_id) ||
                !isPositiveInteger(conflict.judge_id) || !validScoreOrEmpty(conflict.base) ||
                !validScoreOrEmpty(conflict.server) || typeof conflict.local !== "string" ||
                scoreState(conflict.local) !== "valid") {
                return false;
            }
            const conflictKey = key(conflict.singer_id, conflict.judge_id);
            if (seen[conflictKey] || pendingByKey[conflictKey] !== conflict.local)
                return false;
            seen[conflictKey] = true;
            return true;
        });
    }
    function pendingRecord(commandId) {
        const cells = cellsFromDirty();
        if (!validPendingCells(cells))
            return null;
        const conflicts = conflictRecords(cells);
        if (!conflicts || !validPendingConflicts(conflicts, cells))
            return null;
        let baseVersion = state.draftBaseVersion ?? state.version;
        if (!Number.isInteger(baseVersion) || baseVersion < 0)
            baseVersion = state.version;
        const resolvedCommandId = commandId || state.draftCommandId || newCommandId();
        if (typeof resolvedCommandId !== "string" || !resolvedCommandId || resolvedCommandId.length > 64)
            return null;
        state.draftCommandId = resolvedCommandId;
        state.draftBaseVersion = baseVersion;
        const record = {
            activity: activityId,
            round: roundId,
            endpoint: apiUrl,
            base_version: baseVersion,
            cells,
            command_id: resolvedCommandId,
            updated_at: new Date().toISOString(),
        };
        if (conflicts.length)
            record.conflicts = conflicts;
        return record;
    }
    function persistDraft(commandId) {
        const storage = localStorageOrNull();
        const record = pendingRecord(commandId);
        if (!storage)
            return record;
        try {
            if (record)
                storage.setItem(pendingStorageKey, JSON.stringify(record));
            else if (!Object.keys(state.dirty).length)
                storage.removeItem(pendingStorageKey);
        }
        catch (_error) {
            // Storage is a convenience for a client draft; quota/privacy failures do not block scoring.
        }
        return record;
    }
    function clearPendingAfterAck(commandId) {
        const storage = localStorageOrNull();
        if (!storage)
            return;
        try {
            const parsed = JSON.parse(storage.getItem(pendingStorageKey) || "null");
            if (isRecord(parsed) && parsed.command_id === commandId && !Object.keys(state.dirty).length) {
                storage.removeItem(pendingStorageKey);
            }
        }
        catch (_error) {
            // A malformed browser draft is never authoritative and is ignored.
        }
    }
    function validPendingRecord(record) {
        return isRecord(record) && record.activity === activityId && record.round === roundId &&
            record.endpoint === apiUrl && Number.isInteger(record.base_version) &&
            record.base_version >= 0 && typeof record.command_id === "string" &&
            record.command_id.length > 0 && record.command_id.length <= 64 &&
            typeof record.updated_at === "string" && validPendingCells(record.cells) &&
            validPendingConflicts(record.conflicts, record.cells);
    }
    function restorePendingDraft() {
        const storage = localStorageOrNull();
        if (!storage)
            return;
        try {
            const parsed = JSON.parse(storage.getItem(pendingStorageKey) || "null");
            if (!validPendingRecord(parsed))
                return;
            state.draftCommandId = parsed.command_id;
            state.draftBaseVersion = parsed.base_version;
            parsed.cells.forEach((cell) => {
                const cellKey = key(cell.singer_id, cell.judge_id);
                if (!(cellKey in state.cells))
                    return;
                state.dirty[cellKey] = cell.score;
                const input = inputFor(cell.singer_id, cell.judge_id);
                if (input) {
                    input.value = cell.score;
                    setVisual(input, false);
                }
            });
            (parsed.conflicts || []).forEach((conflict) => {
                const conflictKey = key(conflict.singer_id, conflict.judge_id);
                state.conflicts[conflictKey] = conflict;
            });
        }
        catch (_error) {
            // Ignore an untrusted or malformed local draft instead of inventing score facts.
        }
    }
    function scheduleSave() {
        if (state.locked)
            return;
        if (saveTimer)
            clearTimeout(saveTimer);
        saveTimer = setTimeout(flushSave, 500);
    }
    function flushSave() {
        if (saveTimer) {
            clearTimeout(saveTimer);
            saveTimer = null;
        }
        if (state.locked)
            return;
        if (!Object.keys(state.dirty).length)
            return;
        if (Object.keys(state.conflicts).length) {
            showError("存在同一单元格的并发冲突；请先修改冲突单元格后再保存。");
            return;
        }
        const record = persistDraft();
        if (!record)
            return;
        if (navigator.onLine === false) {
            showError("当前离线，评分草稿已保留，联网后将重试。");
            return;
        }
        savePending(record);
    }
    function scheduleRetry(commandId) {
        retryAttempt = Math.min(retryAttempt + 1, 4);
        const delay = Math.min(1000 * Math.pow(2, retryAttempt - 1), 8000);
        if (retryTimer)
            clearTimeout(retryTimer);
        retryTimer = setTimeout(() => {
            retryTimer = null;
            if (navigator.onLine !== false && state.draftCommandId === commandId)
                flushSave();
        }, delay);
    }
    function savePending(record) {
        if (saveInflight)
            return;
        saveInflight = true;
        const payload = JSON.stringify({
            command_id: record.command_id,
            base_version: record.base_version,
            cells: record.cells,
        });
        fetch(apiUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-CSRFToken": csrfToken },
            body: payload,
        })
            .then((resp) => resp.json().then((data) => ({ status: resp.status, data })))
            .then((result) => {
            const data = result.data;
            if (result.status === 200) {
                const saveData = parseSaveResponse(data);
                if (!saveData) {
                    showError("保存响应无效，请稍后重试。");
                    return;
                }
                setVersion(saveData.version);
                record.cells.forEach((cell) => {
                    const cellKey = key(cell.singer_id, cell.judge_id);
                    state.cells[cellKey] = cell.score;
                    if (state.dirty[cellKey] === cell.score)
                        delete state.dirty[cellKey];
                    delete state.conflicts[cellKey];
                });
                retryAttempt = 0;
                if (!Object.keys(state.dirty).length) {
                    state.draftCommandId = null;
                    state.draftBaseVersion = null;
                }
                clearPendingAfterAck(record.command_id);
                persistDraft();
                clearError();
                updateProgress();
                updatePendingCount();
                renderConflicts();
                if (saveData.matrix_complete)
                    setResolved(saveData.resolved_status);
            }
            else if (result.status === 409) {
                if (isRecord(data) && data.reason_code === "IDEMPOTENCY_CONFLICT") {
                    showError("本次保存请求冲突；请刷新后重试。");
                }
                else {
                    showError("数据已过期（他人已更新）；本机草稿已与最新数据比较。");
                    refreshFromServer();
                }
            }
            else if (result.status === 400) {
                showError(flattenDetail(isRecord(data) ? data.detail : undefined));
                // A validation response is not an acknowledgement. Keep the client draft
                // visible and retryable so a changed roster or a corrected value is not lost.
            }
            else if (result.status === 403) {
                showError("无权限：" + flattenDetail(isRecord(data) ? data.detail : undefined));
            }
            else {
                showError("保存失败（HTTP " + result.status + "）。");
            }
        })
            .catch(() => {
            showError("网络错误，保存失败，请稍后重试。");
            scheduleRetry(record.command_id);
        })
            .finally(() => {
            saveInflight = false;
            if (state.draftCommandId && state.draftCommandId !== record.command_id)
                flushSave();
        });
    }
    function flattenDetail(detail) {
        if (!detail)
            return "保存失败。";
        if (typeof detail === "string")
            return detail;
        if (Array.isArray(detail))
            return detail.join("；");
        return JSON.stringify(detail);
    }
    function refreshFromServer() {
        fetch(apiUrl, { method: "GET" })
            .then((resp) => resp.json())
            .then((rawData) => {
            const data = parseGridResponse(rawData);
            if (!data)
                throw new Error("Invalid score grid response");
            const beforeRefresh = {};
            const localDraft = {};
            for (const dirtyKey in state.dirty) {
                const localValue = state.dirty[dirtyKey];
                if (localValue === undefined)
                    continue;
                beforeRefresh[dirtyKey] = state.cells[dirtyKey] || "";
                localDraft[dirtyKey] = localValue;
            }
            setVersion(data.version);
            initCells(data.grid);
            data.grid.forEach((row) => {
                row.cells.forEach((cell) => {
                    const input = inputFor(row.singer_id, cell.judge_id);
                    if (input) {
                        input.value = cell.score || "";
                        setVisual(input, false);
                    }
                });
            });
            state.conflicts = {};
            for (const cellKey in localDraft) {
                const [singerPart, judgePart] = cellKey.split(":");
                const localValue = localDraft[cellKey];
                if (singerPart === undefined || judgePart === undefined || localValue === undefined)
                    continue;
                const serverValue = state.cells[cellKey] || "";
                const singerId = parseInt(singerPart, 10);
                const judgeId = parseInt(judgePart, 10);
                const input = inputFor(singerId, judgeId);
                if (serverValue !== (beforeRefresh[cellKey] || "") && serverValue !== localValue) {
                    state.conflicts[cellKey] = {
                        singer_id: singerId,
                        judge_id: judgeId,
                        base: beforeRefresh[cellKey] || "",
                        server: serverValue,
                        local: localValue,
                    };
                }
                if (input) {
                    input.value = localValue;
                    setVisual(input, false);
                }
            }
            if (Object.keys(localDraft).length) {
                state.draftBaseVersion = data.version;
                persistDraft(state.draftCommandId || undefined);
            }
            updateProgress();
            updatePendingCount();
            renderConflicts();
            setResolved(data.matrix_complete ? data.resolved_status : null);
        })
            .catch(() => {
            showError("无法获取最新评分；本机草稿仍已保留，请稍后重试。");
        });
    }
    function applyCellValue(input, value) {
        if (!input)
            return;
        input.value = value;
        input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    function moveTo(nextInput) {
        if (!nextInput)
            return;
        flushSave();
        nextInput.focus();
        nextInput.select();
    }
    function onKeydown(event) {
        if (state.locked)
            return;
        const input = asInputElement(event.target);
        if (!input || input.tagName !== "INPUT")
            return;
        const judgeId = input.dataset.judgeId || "";
        const row = input.closest("tr");
        if (!row)
            return;
        if (event.key === "Enter" || event.key === "ArrowDown") {
            event.preventDefault();
            const nextRow = row.nextElementSibling;
            if (nextRow) {
                moveTo(nextRow.querySelector('input[data-judge-id="' + judgeId + '"]'));
            }
        }
        else if (event.key === "ArrowRight") {
            event.preventDefault();
            const cols = row.querySelectorAll("input[data-judge-id]");
            const index = Array.prototype.indexOf.call(cols, input);
            if (index < cols.length - 1)
                moveTo(cols[index + 1] || null);
        }
        else if (event.key === "ArrowLeft") {
            event.preventDefault();
            const cols = row.querySelectorAll("input[data-judge-id]");
            const index = Array.prototype.indexOf.call(cols, input);
            if (index > 0)
                moveTo(cols[index - 1] || null);
        }
        else if (event.key === "Escape") {
            const cellKey = key(input.dataset.singerId || "", input.dataset.judgeId || "");
            input.value = state.cells[cellKey] || "";
            setVisual(input, false);
            delete state.dirty[cellKey];
            delete state.conflicts[cellKey];
            persistDraft();
            updatePendingCount();
            renderConflicts();
            input.blur();
        }
    }
    function onPaste(event) {
        if (state.locked || !tbody)
            return;
        const input = asInputElement(event.target);
        if (!input || input.tagName !== "INPUT")
            return;
        const legacyClipboard = window.clipboardData;
        const clipboard = event.clipboardData || legacyClipboard;
        if (!clipboard)
            return;
        const text = clipboard.getData("text");
        if (!text)
            return;
        const hasTab = text.indexOf("\t") !== -1;
        const lines = text.split(/\r?\n/).map((line) => line.replace(/\s+$/g, ""));
        if (!hasTab && lines.length === 1)
            return;
        event.preventDefault();
        const rows = Array.from(tbody.querySelectorAll("tr"));
        const startRowElement = input.closest("tr");
        if (!startRowElement)
            return;
        const cols = Array.from(startRowElement.querySelectorAll("input[data-judge-id]"));
        const startRow = rows.indexOf(startRowElement);
        const startCol = cols.indexOf(input);
        for (let rowOffset = 0; rowOffset < lines.length; rowOffset++) {
            const line = lines[rowOffset];
            if (line === undefined || line === "")
                continue;
            const values = line.split("\t");
            for (let colOffset = 0; colOffset < values.length; colOffset++) {
                const rawValue = values[colOffset];
                if (rawValue === undefined)
                    continue;
                const value = rawValue.replace(/\s+/g, "");
                if (value === "")
                    continue;
                const target = rows[startRow + rowOffset];
                const index = startCol + colOffset;
                if (target && index >= 0 && index < cols.length) {
                    const targetInput = target.querySelectorAll("input[data-judge-id]")[index];
                    if (targetInput)
                        applyCellValue(targetInput, value);
                }
            }
        }
    }
    function onBlur(event) {
        const input = asInputElement(event.target);
        if (input && input.tagName === "INPUT")
            flushSave();
    }
    if (!state.locked && tbody) {
        tbody.addEventListener("input", onInput);
        tbody.addEventListener("keydown", onKeydown);
        tbody.addEventListener("paste", onPaste);
        tbody.addEventListener("blur", onBlur, true);
    }
    if (!state.locked && retryButton) {
        retryButton.addEventListener("click", () => {
            if (retryTimer) {
                clearTimeout(retryTimer);
                retryTimer = null;
            }
            flushSave();
        });
    }
    if (!state.locked) {
        window.addEventListener("online", () => {
            if (retryTimer) {
                clearTimeout(retryTimer);
                retryTimer = null;
            }
            flushSave();
        });
        window.addEventListener("beforeunload", (event) => {
            if (!Object.keys(state.dirty).length)
                return;
            event.preventDefault();
            event.returnValue = "仍有未保存的评分草稿。";
            return event.returnValue;
        });
    }
    initCells(initial.grid);
    restorePendingDraft();
    updateProgress();
    updatePendingCount();
    renderConflicts();
    setVersion(state.version);
})();
