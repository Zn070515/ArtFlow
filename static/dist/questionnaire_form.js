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
        try {
            const response = await fetch(autosaveUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json", "X-CSRFToken": csrfToken() },
                body: JSON.stringify({ answers: collect(), schema_hash: schemaHash }),
            });
            const body = (await response.json());
            if (!response.ok) {
                // A 409 means this page is out of date — either the questionnaire changed under
                // it or the response was already submitted. Never overwrite from a stale form.
                showError(body.error || "保存失败，请刷新后重试。");
                setSaveState("");
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
            setSaveState("已保存");
        }
        catch {
            showError("网络错误，稍后会自动重试。");
            setSaveState("");
        }
        finally {
            inFlight = false;
            if (dirty) {
                dirty = false;
                void save();
            }
        }
    };
    const schedule = () => {
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
