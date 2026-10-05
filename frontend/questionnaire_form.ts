(() => {
  "use strict";

  const root = document.querySelector<HTMLElement>("[data-questionnaire-form]");
  if (!root) return;
  const editable = root.dataset.editable === "1";
  if (!editable) return;

  const autosaveUrl = root.dataset.autosaveUrl || "";
  const uploadTemplate = root.dataset.uploadUrlTemplate || "";
  const schemaHash = root.dataset.schemaHash || "";
  const csrfField = root.querySelector<HTMLInputElement>('input[name="csrfmiddlewaretoken"]');
  const pageCsrfToken = csrfField?.value || "";
  const saveState = root.querySelector<HTMLElement>("[data-save-state]");
  const errorBox = root.querySelector<HTMLElement>("[data-form-error]");
  const requiredCount = root.querySelector<HTMLElement>("[data-completion-required]");
  const requiredAnsweredCount = root.querySelector<HTMLElement>("[data-completion-required-answered]");
  const answeredCount = root.querySelector<HTMLElement>("[data-completion-answered]");
  if (!autosaveUrl || !uploadTemplate) return;

  const TYPING_SETTLE_MS = 800;

  const showError = (message: string): void => {
    if (!errorBox) return;
    errorBox.textContent = message;
    errorBox.classList.remove("hidden");
  };

  const clearError = (): void => {
    if (!errorBox) return;
    errorBox.textContent = "";
    errorBox.classList.add("hidden");
  };

  const setSaveState = (text: string): void => {
    if (saveState) saveState.textContent = text;
  };

  // Only what the participant actually typed is sent. The server decides what each key
  // means — whether it is a bound field, a stored answer, or not a question at all.
  const collect = (): Record<string, unknown> => {
    const answers: Record<string, unknown> = {};
    root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
      "[data-answer]",
    ).forEach((field) => {
      const key = field.dataset.answer;
      if (!key) return;
      if (field instanceof HTMLInputElement && field.type === "checkbox") {
        const question = field.closest<HTMLElement>("[data-question]");
        if (question?.dataset.questionType === "multiple_choice") {
          const selected = Array.isArray(answers[key])
            ? (answers[key] as string[])
            : [];
          if (field.checked) selected.push(field.value);
          answers[key] = selected;
        } else {
          answers[key] = field.checked;
        }
      } else {
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
  const bases = new Map<string, string>();
  const synced = new Map<string, unknown>();
  const initial = collect();
  for (const [key, value] of Object.entries(initial)) synced.set(key, value);
  const basesScript = document.getElementById("questionnaire-answer-bases");
  if (basesScript?.textContent) {
    try {
      const parsed = JSON.parse(basesScript.textContent) as Record<string, string>;
      for (const [key, base] of Object.entries(parsed)) bases.set(key, base);
    } catch {
      // An unreadable map only means the page edits as a whole form, as it did before.
    }
  }
  const applyBases = (incoming: Record<string, string> | undefined): void => {
    if (!incoming) return;
    for (const [key, base] of Object.entries(incoming)) bases.set(key, base);
  };
  const currentChanges = (): Array<{ key: string; base: string; value: unknown }> =>
    Object.entries(collect())
      .filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(synced.get(key)))
      .map(([key, value]) => ({ key, base: bases.get(key) ?? "", value }));

  let timer: number | undefined;
  let inFlight = false;
  let dirty = false;

  const save = async (): Promise<void> => {
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
      setSaveState("已保存");
      return;
    }
    try {
      const response = await fetch(autosaveUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRFToken": csrfToken() },
        body: JSON.stringify(
          casEnabled
            ? { changes, schema_hash: schemaHash }
            : { answers: snapshot, schema_hash: schemaHash },
        ),
      });
      const body = (await response.json()) as {
        completion?: { required?: number; required_answered?: number; answered?: number };
        answer_bases?: Record<string, string>;
        conflicts?: Array<{ key?: unknown; server?: unknown; base?: unknown }>;
        code?: string;
        error?: string;
      };
      if (response.status === 409 && body.code === "QUESTION_STALE") {
        setSaveState("");
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
      if (casEnabled && changes) {
        // Only what this request actually carried. Marking the whole snapshot synced would
        // swallow anything typed while the request was in flight, and the next save would
        // then find nothing to send.
        for (const change of changes) synced.set(change.key, change.value);
      } else {
        for (const [key, value] of Object.entries(snapshot)) synced.set(key, value);
      }
      applyBases(body.answer_bases);
      if (body.completion) {
        if (requiredCount) requiredCount.textContent = String(body.completion.required ?? 0);
        if (requiredAnsweredCount) {
          requiredAnsweredCount.textContent = String(body.completion.required_answered ?? 0);
        }
        if (answeredCount) answeredCount.textContent = String(body.completion.answered ?? 0);
      }
      setSaveState("已保存");
    } catch {
      showError("网络错误，稍后会自动重试。");
      setSaveState("");
    } finally {
      inFlight = false;
      if (dirty) {
        dirty = false;
        void save();
      }
    }
  };

  const handleQuestionStale = (
    changes: Array<{ key: string; base: string; value: unknown }>,
    conflicts: Array<{ key?: unknown; server?: unknown; base?: unknown }>,
  ): void => {
    const staleKeys = new Set(
      conflicts.map((conflict) => String(conflict.key ?? "")).filter(Boolean),
    );
    const shown = [...staleKeys].map((key) => {
      const conflict = conflicts.find((entry) => String(entry.key ?? "") === key);
      return `· ${key}: 服务器「${String(conflict?.server ?? "")}」`;
    });
    const overwrite = window.confirm(
      `以下内容已被其他成员修改：\n\n${shown.join("\n")}\n\n` +
        `选择“确定”用你的内容覆盖；选择“取消”保留服务器上的版本。`,
    );
    if (!overwrite) {
      // Keep the teammate's text, and re-sync so the next edit is built on it.
      void fetch(autosaveUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRFToken": csrfToken() },
        body: JSON.stringify({ changes: [], schema_hash: schemaHash }),
      })
        .then(async (response) => {
          const body = (await response.json()) as { answer_bases?: Record<string, string> };
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
      if (key) bases.set(key, String(conflict.base ?? ""));
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

  const schedule = (): void => {
    if (timer !== undefined) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      void save();
    }, TYPING_SETTLE_MS);
  };

  const csrfToken = (): string => {
    return pageCsrfToken;
  };

  root.querySelectorAll<HTMLElement>("[data-answer]").forEach((field) => {
    field.addEventListener(field instanceof HTMLSelectElement ? "change" : "input", schedule);
  });

  // A group shares one file per question, so an upload says which current version it is
  // replacing. Without that a member working from a stale page would silently overwrite a
  // teammate's final upload — the one artifact the group must produce.
  const fileVersionLabel = (key: string): HTMLElement | null =>
    root.querySelector<HTMLElement>(`[data-file-version="${key}"]`);

  const uploadFile = async (
    key: string,
    file: File,
    label: HTMLElement | null,
    expectedVersion: string,
  ): Promise<void> => {
    const form = new FormData();
    form.append("file", file);
    form.append("schema_hash", schemaHash);
    form.append("expected_current_version", expectedVersion);
    setSaveState("上传中…");
    let body: { file_name?: string; version?: number; error?: string; code?: string; current_version?: number; current_name?: string };
    try {
      const response = await fetch(uploadTemplate.replace("__KEY__", encodeURIComponent(key)), {
        method: "POST",
        headers: { "X-CSRFToken": csrfToken() },
        body: form,
      });
      body = (await response.json()) as typeof body;
      if (response.status === 409 && body.code === "FILE_SLOT_STALE") {
        const current = body.current_name || "当前版本";
        const replace = window.confirm(
          `该材料已被其他成员更新为「${current}」。\n\n` +
            `选择“确定”用你的文件替换它；选择“取消”保留当前版本。`,
        );
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
    } catch {
      showError("网络错误，上传失败。");
      setSaveState("");
      return;
    }
    clearError();
    if (label && body.file_name) label.textContent = body.file_name;
    if (label && body.version !== undefined) label.dataset.fileVersion = String(body.version);
    setSaveState("已上传");
  };

  // A file is uploaded on its own the moment it is chosen: it is not draft text, and it
  // has its own authority (the check the question stands for). The response replaces just
  // that question's file.
  root.querySelectorAll<HTMLInputElement>("[data-file-answer]").forEach((input) => {
    input.addEventListener("change", () => {
      const key = input.dataset.fileAnswer;
      const file = input.files && input.files[0];
      if (!key || !file) return;
      const label = fileVersionLabel(key);
      void uploadFile(key, file, label, label?.dataset.fileVersion ?? "0");
    });
  });

  const submitUrl = root.dataset.submitUrl || "";
  const submitButton = root.querySelector<HTMLButtonElement>("[data-submit-questionnaire]");
  const submitState = root.querySelector<HTMLElement>("[data-submit-state]");
  if (!submitUrl || !submitButton) return;

  submitButton.addEventListener("click", () => {
    // A submission carries the whole form, so a save still in flight would only be
    // overwritten. Let it land first, then submit what is actually on screen.
    if (timer !== undefined) window.clearTimeout(timer);
    submitButton.disabled = true;
    setSaveState("");
    void fetch(submitUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRFToken": csrfToken() },
      body: JSON.stringify({ answers: collect(), schema_hash: schemaHash }),
    })
      .then(async (response) => {
        const body = (await response.json()) as {
          status?: string;
          error?: string;
          completion?: { required?: number; required_answered?: number; answered?: number };
        };
        if (!response.ok) {
          showError(body.error || "提交失败，请检查后重试。");
          return;
        }
        clearError();
        if (body.completion) {
          if (requiredCount) requiredCount.textContent = String(body.completion.required ?? 0);
          if (requiredAnsweredCount) {
            requiredAnsweredCount.textContent = String(body.completion.required_answered ?? 0);
          }
          if (answeredCount) answeredCount.textContent = String(body.completion.answered ?? 0);
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
