(() => {
  "use strict";

  const root = document.querySelector<HTMLElement>("[data-questionnaire-form]");
  if (!root) return;
  const editable = root.dataset.editable === "1";
  if (!editable) return;

  const autosaveUrl = root.dataset.autosaveUrl || "";
  const uploadTemplate = root.dataset.uploadUrlTemplate || "";
  const schemaHash = root.dataset.schemaHash || "";
  const saveState = root.querySelector<HTMLElement>("[data-save-state]");
  const errorBox = root.querySelector<HTMLElement>("[data-form-error]");
  const requiredCount = root.querySelector<HTMLElement>("[data-completion-required]");
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
        answers[key] = field.checked;
      } else {
        answers[key] = field.value;
      }
    });
    return answers;
  };

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
    try {
      const response = await fetch(autosaveUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRFToken": csrfToken() },
        body: JSON.stringify({ answers: collect(), schema_hash: schemaHash }),
      });
      const body = (await response.json()) as {
        completion?: { required?: number; answered?: number };
        error?: string;
      };
      if (!response.ok) {
        // A 409 means this page is out of date — either the questionnaire changed under
        // it or the response was already submitted. Never overwrite from a stale form.
        showError(body.error || "保存失败，请刷新后重试。");
        setSaveState("");
        return;
      }
      clearError();
      if (body.completion) {
        if (requiredCount) requiredCount.textContent = String(body.completion.required ?? 0);
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

  const schedule = (): void => {
    if (timer !== undefined) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      void save();
    }, TYPING_SETTLE_MS);
  };

  const csrfToken = (): string => {
    const match = document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/);
    return match && match[1] ? decodeURIComponent(match[1]) : "";
  };

  root.querySelectorAll<HTMLElement>("[data-answer]").forEach((field) => {
    field.addEventListener(field instanceof HTMLSelectElement ? "change" : "input", schedule);
  });

  // A file is uploaded on its own the moment it is chosen: it is not draft text, and it
  // has its own authority (the check the question stands for). The response replaces just
  // that question's file.
  root.querySelectorAll<HTMLInputElement>("[data-file-answer]").forEach((input) => {
    input.addEventListener("change", () => {
      const key = input.dataset.fileAnswer;
      const file = input.files && input.files[0];
      if (!key || !file) return;
      const form = new FormData();
      form.append("file", file);
      form.append("schema_hash", schemaHash);
      setSaveState("上传中…");
      void fetch(uploadTemplate.replace("__KEY__", encodeURIComponent(key)), {
        method: "POST",
        headers: { "X-CSRFToken": csrfToken() },
        body: form,
      })
        .then(async (response) => {
          const body = (await response.json()) as { file_name?: string; error?: string };
          if (!response.ok) {
            showError(body.error || "上传失败，请重试。");
            setSaveState("");
            return;
          }
          clearError();
          const label = root.querySelector<HTMLElement>(`[data-file-name="${key}"]`);
          if (label && body.file_name) label.textContent = body.file_name;
          setSaveState("已上传");
        })
        .catch(() => {
          showError("网络错误，上传失败。");
          setSaveState("");
        });
    });
  });
})();
