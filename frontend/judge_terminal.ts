(() => {
  "use strict";

  interface Criterion {
    name: string;
    max_score: string;
    sequence: number;
  }

  interface JudgeContext {
    activity_id: number;
    round_id: number;
    seat_id: number;
    panel_snapshot_id: number;
    panel_version: number;
    context_version: number;
    performance_id: number | null;
    performance_state: string;
    rubric_payload: { name?: string; criteria: Criterion[] };
  }

  interface ScorePayload {
    score: string;
    notes: string;
  }

  interface Draft {
    command_id: string;
    context_fingerprint: string;
    score_payload: ScorePayload;
  }

  interface ScoreReceipt {
    receipt_id: number;
    score_record_id: number;
    reason_code: string;
    status: string;
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
  }

  function positiveInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isInteger(value) && value > 0;
  }

  function nonNegativeInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isInteger(value) && value >= 0;
  }

  function parseContext(value: unknown): JudgeContext | null {
    if (!isRecord(value) || !isRecord(value.context)) return null;
    const candidate = value.context;
    if (
      !positiveInteger(candidate.activity_id) ||
      !positiveInteger(candidate.round_id) ||
      !positiveInteger(candidate.seat_id) ||
      !positiveInteger(candidate.panel_snapshot_id) ||
      !positiveInteger(candidate.panel_version) ||
      !nonNegativeInteger(candidate.context_version) ||
      (candidate.performance_id !== null && !positiveInteger(candidate.performance_id)) ||
      typeof candidate.performance_state !== "string" ||
      !isRecord(candidate.rubric_payload) ||
      !Array.isArray(candidate.rubric_payload.criteria)
    ) return null;
    const criteria = candidate.rubric_payload.criteria.flatMap((item: unknown) => {
      if (!isRecord(item) || typeof item.name !== "string" ||
        typeof item.max_score !== "string" || !nonNegativeInteger(item.sequence)) return [];
      return [{ name: item.name, max_score: item.max_score, sequence: item.sequence }];
    });
    if (criteria.length !== candidate.rubric_payload.criteria.length) return null;
    return {
      activity_id: candidate.activity_id,
      round_id: candidate.round_id,
      seat_id: candidate.seat_id,
      panel_snapshot_id: candidate.panel_snapshot_id,
      panel_version: candidate.panel_version,
      context_version: candidate.context_version,
      performance_id: candidate.performance_id,
      performance_state: candidate.performance_state,
      rubric_payload: {
        name: typeof candidate.rubric_payload.name === "string"
          ? candidate.rubric_payload.name
          : undefined,
        criteria,
      },
    };
  }

  function parseSession(value: unknown): string | null {
    if (!isRecord(value) || value.kind !== "judge" || typeof value.session_token !== "string") {
      return null;
    }
    return value.session_token.length > 0 ? value.session_token : null;
  }

  function parseReceipt(value: unknown): ScoreReceipt | null {
    if (!isRecord(value) || !isRecord(value.receipt) ||
      !positiveInteger(value.receipt.receipt_id) ||
      !positiveInteger(value.receipt.score_record_id) ||
      value.receipt.status !== "succeeded" ||
      typeof value.receipt.reason_code !== "string") return null;
    return {
      receipt_id: value.receipt.receipt_id,
      score_record_id: value.receipt.score_record_id,
      reason_code: value.receipt.reason_code,
      status: value.receipt.status,
    };
  }

  function validScore(value: string): boolean {
    if (!/^\d{1,3}(\.\d{1,2})?$/.test(value.trim())) return false;
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric >= 0 && numeric <= 100;
  }

  function commandId(): string {
    if (typeof crypto.randomUUID === "function") return `judge-${crypto.randomUUID()}`;
    return `judge-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  }

  function localStorageOrNull(): Storage | null {
    try {
      return window.localStorage;
    } catch {
      return null;
    }
  }

  function statusText(root: HTMLElement, message: string): void {
    const element = root.querySelector<HTMLElement>("[data-status]");
    if (element) element.textContent = message;
  }

  const root = document.querySelector<HTMLElement>("[data-judge-terminal]");
  if (!root) return;
  const scoreInput = root.querySelector<HTMLInputElement>("[data-score]");
  const notesInput = root.querySelector<HTMLTextAreaElement>("[data-notes]");
  const submitButton = root.querySelector<HTMLButtonElement>("[data-submit]");
  if (!scoreInput || !submitButton) return;
  const terminalRoot = root;
  const scoreField = scoreInput;
  const notesField = notesInput;
  const submitControl = submitButton;

  const redeemUrl = root.dataset.redeemUrl || "/entry-access/grants/redeem/";
  const contextUrl = root.dataset.contextUrl || "/judge/context/";
  const scoreUrl = root.dataset.scoreUrl || "/judge/score/";
  const storageKey = "artflow:judge:draft";
  let sessionToken: string | null = null;
  let context: JudgeContext | null = null;
  let draft: Draft | null = null;

  function contextFingerprint(value: JudgeContext): string {
    return [value.activity_id, value.round_id, value.seat_id, value.panel_snapshot_id,
      value.panel_version, value.context_version, value.performance_id ?? "none"].join(":");
  }

  function readDraft(fingerprint: string): Draft | null {
    const storage = localStorageOrNull();
    if (!storage) return null;
    try {
      const value: unknown = JSON.parse(storage.getItem(storageKey) || "null");
      if (!isRecord(value) || typeof value.command_id !== "string" ||
        value.context_fingerprint !== fingerprint || !isRecord(value.score_payload) ||
        typeof value.score_payload.score !== "string" || typeof value.score_payload.notes !== "string" ||
        value.command_id.length === 0 || value.command_id.length > 64 ||
        value.score_payload.notes.length > 200 || !validScore(value.score_payload.score)) return null;
      return {
        command_id: value.command_id,
        context_fingerprint: fingerprint,
        score_payload: { score: value.score_payload.score, notes: value.score_payload.notes },
      };
    } catch {
      return null;
    }
  }

  function persistDraft(value: Draft): void {
    const storage = localStorageOrNull();
    if (!storage) return;
    try {
      storage.setItem(storageKey, JSON.stringify(value));
    } catch {
      // A local draft is a convenience and never changes server authority.
    }
  }

  function clearDraft(command: string): void {
    const storage = localStorageOrNull();
    if (!storage || !draft || draft.command_id !== command) return;
    try {
      storage.removeItem(storageKey);
    } catch {
      // Ignore storage privacy/quota failures.
    }
  }

  async function jsonResponse(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }

  async function redeem(fragment: string): Promise<string | null> {
    const response = await fetch(redeemUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: fragment }),
    });
    return response.ok ? parseSession(await jsonResponse(response)) : null;
  }

  async function loadContext(token: string): Promise<JudgeContext | null> {
    const response = await fetch(contextUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return response.ok ? parseContext(await jsonResponse(response)) : null;
  }

  async function submit(): Promise<void> {
    if (!context || !sessionToken || !validScore(scoreField.value) || (notesField?.value.length ?? 0) > 200) {
      statusText(terminalRoot, "评分内容无效。");
      return;
    }
    if (!context.performance_id || !["performing", "accepting_score"].includes(context.performance_state)) {
      statusText(terminalRoot, "当前没有可评分的表演。");
      return;
    }
    if (!draft) {
      draft = {
        command_id: commandId(),
        context_fingerprint: contextFingerprint(context),
        score_payload: { score: scoreField.value.trim(), notes: notesField?.value.trim() || "" },
      };
    }
    persistDraft(draft);
    submitControl.disabled = true;
    statusText(terminalRoot, "正在提交评分……");
    try {
      const response = await fetch(scoreUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${sessionToken}` },
        body: JSON.stringify({
          command_id: draft.command_id,
          expected_context_version: context.context_version,
          expected_performance_id: context.performance_id,
          score_payload: draft.score_payload,
        }),
      });
      const data = await jsonResponse(response);
      if (response.ok && parseReceipt(data)) {
        clearDraft(draft.command_id);
        statusText(terminalRoot, "评分已确认。");
      } else if (isRecord(data) && data.reason_code === "STALE_CONTEXT") {
        statusText(terminalRoot, "现场上下文已变化，当前草稿未提交。");
      } else if (isRecord(data) && data.reason_code === "PANEL_CHANGED_MID_ROUND") {
        statusText(terminalRoot, "评委组已变化，当前草稿未提交。");
      } else if (isRecord(data) && data.reason_code === "DUPLICATE_SCORE_FACT") {
        statusText(terminalRoot, "该评委席位已经提交过此表演的评分。");
      } else {
        statusText(terminalRoot, "评分未被接受，请保留草稿并联系现场工作人员。");
      }
    } catch {
      statusText(terminalRoot, "网络暂时不可用，评分草稿已保留；可安全重试。");
    } finally {
      submitControl.disabled = false;
    }
  }

  async function boot(): Promise<void> {
    const fragment = window.location.hash.slice(1);
    if (!fragment) {
      statusText(terminalRoot, "请使用现场二维码进入评委终端。");
      return;
    }
    window.history.replaceState(null, "", window.location.pathname);
    try {
      sessionToken = await redeem(decodeURIComponent(fragment));
      if (!sessionToken) throw new Error("invalid grant");
      context = await loadContext(sessionToken);
      if (!context) throw new Error("invalid context");
      draft = readDraft(contextFingerprint(context));
      if (draft) {
        scoreField.value = draft.score_payload.score;
        if (notesField) notesField.value = draft.score_payload.notes;
      }
      statusText(terminalRoot, "评委终端已就绪。");
    } catch {
      sessionToken = null;
      context = null;
      statusText(terminalRoot, "评委会话无效或已过期，请重新扫描现场二维码。");
    }
  }

  submitControl.addEventListener("click", () => { void submit(); });
  window.addEventListener("beforeunload", () => { sessionToken = null; });
  void boot();
})();
