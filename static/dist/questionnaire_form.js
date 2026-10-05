"use strict";
(() => {
    "use strict";
    const root = document.querySelector("[data-questionnaire-form]");
    if (!root)
        return;
    const editable = root.dataset.editable === "1";
    if (!editable)
        return;
    const autosaveUrl = root.dataset.autosaveUrl || "";
    const uploadTemplate = root.dataset.uploadUrlTemplate || "";
    const schemaHash = root.dataset.schemaHash || "";
    const csrfField = root.querySelector('input[name="csrfmiddlewaretoken"]');
    const pageCsrfToken = csrfField?.value || "";
    const saveState = root.querySelector("[data-save-state]");
    const errorBox = root.querySelector("[data-form-error]");
    const requiredCount = root.querySelector("[data-completion-required]");
    const requiredAnsweredCount = root.querySelector("[data-completion-required-answered]");
    const answeredCount = root.querySelector("[data-completion-answered]");
    if (!autosaveUrl || !uploadTemplate)
        return;
    const TYPING_SETTLE_MS = 800;
    const showError = (message) => {
        if (!errorBox)
            return;
        errorBox.textContent = message;
        errorBox.classList.remove("hidden");
    };
    const clearError = () => {
        if (!errorBox)
            return;
        errorBox.textContent = "";
        errorBox.classList.add("hidden");
    };
    const setSaveState = (text) => {
        if (saveState)
            saveState.textContent = text;
    };
    // Only what the participant actually typed is sent. The server decides what each key
    // means — whether it is a bound field, a stored answer, or not a question at all.
    const collect = () => {
        const answers = {};
        root.querySelectorAll("[data-answer]").forEach((field) => {
            const key = field.dataset.answer;
            if (!key)
                return;
            if (field instanceof HTMLInputElement && field.type === "checkbox") {
                const question = field.closest("[data-question]");
                if (question?.dataset.questionType === "multiple_choice") {
                    const selected = Array.isArray(answers[key])
                        ? answers[key]
                        : [];
                    if (field.checked)
                        selected.push(field.value);
                    answers[key] = selected;
                }
                else {
                    answers[key] = field.checked;
                }
            }
            else {
                answers[key] = field.value;
            }
        });
        return answers;
    };
    // A shared group response is edited by several members at once, so the page declares
    // which answer base it is looking at and the server refuses a base that has moved. The
    // bases come from the server (one token per stored answer), so an untouched checkbox —
    // absent in the database, `false` in the DOM — can never look like a change.
    const casEnabled = root.dataset.cas === "1";
    const bases = new Map();
    const synced = new Map();
    const initial = collect();
    for (const [key, value] of Object.entries(initial))
        synced.set(key, value);
    const basesScript = document.getElementById("questionnaire-answer-bases");
    if (basesScript?.textContent) {
        try {
            const parsed = JSON.parse(basesScript.textContent);
            for (const [key, base] of Object.entries(parsed))
                bases.set(key, base);
        }
        catch {
            // An unreadable map only means the page edits as a whole form, as it did before.
        }
    }
    const applyBases = (incoming) => {
        if (!incoming)
            return;
        for (const [key, base] of Object.entries(incoming))
            bases.set(key, base);
    };
    const currentChanges = () => Object.entries(collect())
        .filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(synced.get(key)))
        .map(([key, value]) => ({ key, base: bases.get(key) ?? "", value }));
    // Durability, borrowed from the rapid-score page: the unsent draft lives in
    // localStorage, survives a refresh and a closed tab, and is retried on a backoff and
    // when the connection returns. Without it "稍后会自动重试" was a promise nothing kept —
    // a single dropped request lost whatever the member had typed since the last save.
    const pendingStorageKey = `questionnaire-pending:${window.location.pathname}`;
    const storageOrNull = () => {
        try {
            return window.localStorage || null;
        }
        catch {
            return null;
        }
    };
    const persistPending = () => {
        const storage = storageOrNull();
        if (!storage)
            return;
        try {
            const record = casEnabled
                ? { mode: "changes", changes: currentChanges() }
                : { mode: "answers", answers: collect() };
            if (record.mode === "changes" && record.changes.length === 0) {
                storage.removeItem(pendingStorageKey);
                return;
            }
            storage.setItem(pendingStorageKey, JSON.stringify(record));
        }
        catch {
            // A full or disabled store only means no local copy; the form still saves normally.
        }
    };
    const clearPending = () => {
        storageOrNull()?.removeItem(pendingStorageKey);
    };
    const hasPending = () => Boolean(storageOrNull()?.getItem(pendingStorageKey));
    const applyAnswerValue = (key, value) => {
        const fields = root.querySelectorAll(`[data-answer="${CSS.escape(key)}"]`);
        if (fields.length === 0)
            return false;
        fields.forEach((field) => {
            if (field instanceof HTMLInputElement && field.type === "checkbox") {
                field.checked = Array.isArray(value) ? value.includes(field.value) : value === true;
            }
            else if (field instanceof HTMLInputElement && field.type === "radio") {
                field.checked = field.value === String(value ?? "");
            }
            else {
                field.value = value === null || value === undefined ? "" : String(value);
            }
        });
        return true;
    };
    const restorePending = () => {
        const storage = storageOrNull();
        const raw = storage?.getItem(pendingStorageKey);
        if (!storage || !raw)
            return;
        let record;
        try {
            record = JSON.parse(raw);
        }
        catch {
            storage.removeItem(pendingStorageKey);
            return;
        }
        const pairs = record.mode === "changes"
            ? (record.changes ?? []).map((change) => [String(change.key ?? ""), change.value])
            : Object.entries(record.answers ?? {});
        const restored = pairs.filter(([key, value]) => key !== "" && applyAnswerValue(key, value)).length;
        if (restored > 0) {
            showError("已恢复上次未保存的内容，正在重新保存。");
            void save();
        }
        else {
            storage.removeItem(pendingStorageKey);
        }
    };
    let retryTimer;
    let retryAttempt = 0;
    const scheduleRetry = () => {
        retryAttempt = Math.min(retryAttempt + 1, 4);
        const delay = Math.min(1000 * 2 ** (retryAttempt - 1), 8000);
        if (retryTimer !== undefined)
            window.clearTimeout(retryTimer);
        retryTimer = window.setTimeout(() => {
            retryTimer = undefined;
            if (navigator.onLine !== false)
                void save();
        }, delay);
    };
    window.addEventListener("online", () => {
        if (hasPending())
            void save();
    });
    window.addEventListener("beforeunload", (event) => {
        if (!hasPending())
            return;
        event.preventDefault();
        // Older engines only honour the property form.
        event.returnValue = "";
    });
    let timer;
    let inFlight = false;
    let dirty = false;
    const save = async () => {
        if (inFlight) {
            dirty = true;
            return;
        }
        inFlight = true;
        setSaveState("保存中…");
        const snapshot = collect();
        const changes = casEnabled ? currentChanges() : null;
        if (casEnabled && changes && changes.length === 0) {
            inFlight = false;
            // Nothing unsent: any earlier local copy is obsolete.
            clearPending();
            setSaveState("已保存");
            return;
        }
        // Written before the request, not after it fails: a tab closed mid-request must not
        // lose the text either.
        persistPending();
        try {
            const response = await fetch(autosaveUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json", "X-CSRFToken": csrfToken() },
                body: JSON.stringify(casEnabled
                    ? { changes, schema_hash: schemaHash }
                    : { answers: snapshot, schema_hash: schemaHash }),
            });
            const body = (await response.json());
            if (response.status === 409 && body.code === "QUESTION_STALE") {
                setSaveState("");
                // The draft stays in localStorage: the author still has to decide, and a reload
                // while deciding must not lose their text.
                handleQuestionStale(changes ?? [], body.conflicts ?? []);
                return;
            }
            if (!response.ok) {
                // A 409 means this page is out of date — either the questionnaire changed under
                // it or the response was already submitted. Never overwrite from a stale form.
                showError(body.error || "保存失败，请刷新后重试。");
                setSaveState("");
                return;
            }
            clearError();
            retryAttempt = 0;
            clearPending();
            if (casEnabled && changes) {
                // Only what this request actually carried. Marking the whole snapshot synced would
                // swallow anything typed while the request was in flight, and the next save would
                // then find nothing to send.
                for (const change of changes)
                    synced.set(change.key, change.value);
            }
            else {
                for (const [key, value] of Object.entries(snapshot))
                    synced.set(key, value);
            }
            applyBases(body.answer_bases);
            if (body.completion) {
                if (requiredCount)
                    requiredCount.textContent = String(body.completion.required ?? 0);
                if (requiredAnsweredCount) {
                    requiredAnsweredCount.textContent = String(body.completion.required_answered ?? 0);
                }
                if (answeredCount)
                    answeredCount.textContent = String(body.completion.answered ?? 0);
            }
            setSaveState("已保存");
        }
        catch {
            // Now a promise the page keeps: the draft is already in localStorage, and this
            // schedules the retry that the message has always claimed.
            showError(navigator.onLine === false
                ? "当前离线，内容已保存在本机，联网后会重试。"
                : "网络错误，稍后会自动重试。");
            setSaveState("");
            scheduleRetry();
        }
        finally {
            inFlight = false;
            if (dirty) {
                dirty = false;
                void save();
            }
        }
    };
    const handleQuestionStale = (changes, conflicts) => {
        const staleKeys = new Set(conflicts.map((conflict) => String(conflict.key ?? "")).filter(Boolean));
        const shown = [...staleKeys].map((key) => {
            const conflict = conflicts.find((entry) => String(entry.key ?? "") === key);
            return `· ${key}: 服务器「${String(conflict?.server ?? "")}」`;
        });
        const overwrite = window.confirm(`以下内容已被其他成员修改：\n\n${shown.join("\n")}\n\n` +
            `选择“确定”用你的内容覆盖；选择“取消”保留服务器上的版本。`);
        if (!overwrite) {
            // Keep the teammate's text, and re-sync so the next edit is built on it.
            void fetch(autosaveUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json", "X-CSRFToken": csrfToken() },
                body: JSON.stringify({ changes: [], schema_hash: schemaHash }),
            })
                .then(async (response) => {
                const body = (await response.json());
                applyBases(body.answer_bases);
                window.location.reload();
            })
                .catch(() => showError("保存失败，请刷新后重试。"));
            return;
        }
        // Retry against the base the server just reported, so a third edit in between is
        // caught again rather than overwritten.
        for (const conflict of conflicts) {
            const key = String(conflict.key ?? "");
            if (key)
                bases.set(key, String(conflict.base ?? ""));
        }
        for (const change of changes) {
            if (staleKeys.has(change.key)) {
                const conflict = conflicts.find((entry) => String(entry.key ?? "") === change.key);
                change.base = String(conflict?.base ?? "");
            }
        }
        dirty = true;
        void save();
    };
    const schedule = () => {
        // Local first: the keystroke is durable before any request is attempted.
        persistPending();
        if (timer !== undefined)
            window.clearTimeout(timer);
        timer = window.setTimeout(() => {
            void save();
        }, TYPING_SETTLE_MS);
    };
    const csrfToken = () => {
        return pageCsrfToken;
    };
    root.querySelectorAll("[data-answer]").forEach((field) => {
        field.addEventListener(field instanceof HTMLSelectElement ? "change" : "input", schedule);
    });
    // Anything the last visit left unsent comes back before the page looks editable.
    restorePending();
    // A group shares one file per question, so an upload says which current version it is
    // replacing. Without that a member working from a stale page would silently overwrite a
    // teammate's final upload — the one artifact the group must produce.
    const fileVersionLabel = (key) => root.querySelector(`[data-file-version="${key}"]`);
    const uploadFile = async (key, file, label, expectedVersion) => {
        const form = new FormData();
        form.append("file", file);
        form.append("schema_hash", schemaHash);
        form.append("expected_current_version", expectedVersion);
        setSaveState("上传中…");
        let body;
        try {
            const response = await fetch(uploadTemplate.replace("__KEY__", encodeURIComponent(key)), {
                method: "POST",
                headers: { "X-CSRFToken": csrfToken() },
                body: form,
            });
            body = (await response.json());
            if (response.status === 409 && body.code === "FILE_SLOT_STALE") {
                const current = body.current_name || "当前版本";
                const replace = window.confirm(`该材料已被其他成员更新为「${current}」。\n\n` +
                    `选择“确定”用你的文件替换它；选择“取消”保留当前版本。`);
                setSaveState("");
                if (replace) {
                    // Re-send against the version the server just reported, so a third upload in
                    // between is caught again rather than overwritten.
                    await uploadFile(key, file, label, String(body.current_version ?? 0));
                }
                return;
            }
            if (!response.ok) {
                showError(body.error || "上传失败，请重试。");
                setSaveState("");
                return;
            }
        }
        catch {
            showError("网络错误，上传失败。");
            setSaveState("");
            return;
        }
        clearError();
        if (label && body.file_name)
            label.textContent = body.file_name;
        if (label && body.version !== undefined)
            label.dataset.fileVersion = String(body.version);
        setSaveState("已上传");
    };
    // A file is uploaded on its own the moment it is chosen: it is not draft text, and it
    // has its own authority (the check the question stands for). The response replaces just
    // that question's file.
    root.querySelectorAll("[data-file-answer]").forEach((input) => {
        input.addEventListener("change", () => {
            const key = input.dataset.fileAnswer;
            const file = input.files && input.files[0];
            if (!key || !file)
                return;
            const label = fileVersionLabel(key);
            void uploadFile(key, file, label, label?.dataset.fileVersion ?? "0");
        });
    });
    const submitUrl = root.dataset.submitUrl || "";
    const submitButton = root.querySelector("[data-submit-questionnaire]");
    const submitState = root.querySelector("[data-submit-state]");
    if (!submitUrl || !submitButton)
        return;
    submitButton.addEventListener("click", () => {
        // A submission carries the whole form, so a save still in flight would only be
        // overwritten. Let it land first, then submit what is actually on screen.
        if (timer !== undefined)
            window.clearTimeout(timer);
        submitButton.disabled = true;
        setSaveState("");
        void fetch(submitUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-CSRFToken": csrfToken() },
            body: JSON.stringify({ answers: collect(), schema_hash: schemaHash }),
        })
            .then(async (response) => {
            const body = (await response.json());
            if (!response.ok) {
                showError(body.error || "提交失败，请检查后重试。");
                return;
            }
            clearError();
            if (body.completion) {
                if (requiredCount)
                    requiredCount.textContent = String(body.completion.required ?? 0);
                if (requiredAnsweredCount) {
                    requiredAnsweredCount.textContent = String(body.completion.required_answered ?? 0);
                }
                if (answeredCount)
                    answeredCount.textContent = String(body.completion.answered ?? 0);
            }
            if (submitState) {
                submitState.textContent = "已提交。报名开放期间仍可修改；截止后将锁定。";
                submitState.classList.remove("text-gray-500");
                submitState.classList.add("text-green-700");
            }
            submitButton.textContent = "更新报名";
        })
            .catch(() => {
            showError("网络错误，提交失败。");
        })
            .finally(() => {
            submitButton.disabled = false;
        });
    });
})();
