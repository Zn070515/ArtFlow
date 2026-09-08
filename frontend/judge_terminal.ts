(() => {
  "use strict";

  interface Criterion {
    criterion_id: number;
    name: string;
    description: string;
    max_score: string;
    sequence: number;
  }

  interface JudgeContext {
    activity_id: number;
    round_id: number;
    round_name: string;
    seat_id: number;
    panel_snapshot_id: number;
    panel_version: number;
    context_version: number;
    performance_id: number | null;
    performance_label: string | null;
    singer_name: string | null;
    song_title: string | null;
    performance_state: string;
    rubric_payload: { name?: string; criteria: Criterion[] };
  }

  interface DraftPayload {
    score: string;
    notes: string;
    criteria: Record<string, string>;
  }

  interface Draft {
    command_id: string;
    context_fingerprint: string;
    score_payload: DraftPayload;
  }

  interface ScorePayload {
    score?: string;
    criteria?: Array<{ criterion_id: number; value: string }>;
    notes: string;
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

  function optionalText(value: unknown): string | null {
    return value === null ? null : typeof value === "string" ? value : null;
  }

  function parseContext(value: unknown): JudgeContext | null {
    if (!isRecord(value) || !isRecord(value.context)) return null;
    const candidate = value.context;
    if (
      !positiveInteger(candidate.activity_id) ||
      !positiveInteger(candidate.round_id) ||
      typeof candidate.round_name !== "string" ||
      !positiveInteger(candidate.seat_id) ||
      !positiveInteger(candidate.panel_snapshot_id) ||
      !positiveInteger(candidate.panel_version) ||
      !nonNegativeInteger(candidate.context_version) ||
      (candidate.performance_id !== null && !positiveInteger(candidate.performance_id)) ||
      typeof candidate.performance_state !== "string" ||
      !isRecord(candidate.rubric_payload)
    ) return null;

    const rawCriteria = candidate.rubric_payload.criteria;
    const criteria = Array.isArray(rawCriteria) ? rawCriteria.flatMap((item: unknown) => {
      if (
        !isRecord(item) ||
        !positiveInteger(item.criterion_id) ||
        typeof item.name !== "string" ||
        typeof item.max_score !== "string" ||
        !nonNegativeInteger(item.sequence)
      ) return [];
      return [{
        criterion_id: item.criterion_id,
        name: item.name,
        description: typeof item.description === "string" ? item.description : "",
        max_score: item.max_score,
        sequence: item.sequence,
      }];
    }) : [];
    if (Array.isArray(rawCriteria) && criteria.length !== rawCriteria.length) return null;

    return {
      activity_id: candidate.activity_id,
      round_id: candidate.round_id,
      round_name: candidate.round_name,
      seat_id: candidate.seat_id,
      panel_snapshot_id: candidate.panel_snapshot_id,
      panel_version: candidate.panel_version,
      context_version: candidate.context_version,
      performance_id: candidate.performance_id,
      performance_label: optionalText(candidate.performance_label),
      singer_name: optionalText(candidate.singer_name),
      song_title: optionalText(candidate.song_title),
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

  function validCriterionValue(value: string, criterion: Criterion): boolean {
    if (!validScore(value)) return false;
    const maxScore = Number(criterion.max_score);
    return Number.isFinite(maxScore) && Number(value.trim()) <= maxScore;
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
  const roundField = root.querySelector<HTMLElement>("[data-round]");
  const performanceField = root.querySelector<HTMLElement>("[data-performance-label]");
  const singerField = root.querySelector<HTMLElement>("[data-singer]");
  const songField = root.querySelector<HTMLElement>("[data-song]");
  const stateField = root.querySelector<HTMLElement>("[data-performance-state]");
  const criteriaContainer = root.querySelector<HTMLElement>("[data-criteria]");
  const totalField = root.querySelector<HTMLElement>("[data-total]");

  const redeemUrl = root.dataset.redeemUrl || "/entry-access/grants/redeem/";
  const contextUrl = root.dataset.contextUrl || "/judge/context/";
  const scoreUrl = root.dataset.scoreUrl || "/judge/score/";
  const legacyStorageKey = "artflow:judge:draft";
  const storageKeyPrefix = "artflow:judge:draft:";
  const maxDrafts = 8;
  let sessionToken: string | null = null;
  let context: JudgeContext | null = null;
  let draft: Draft | null = null;
  let draftTimer: number | null = null;
  let pollTimer: number | null = null;
  let pollInFlight = false;
  let pollDelay = 2000;
  let stopped = false;
  let contextRequest: Promise<JudgeContext | null> | null = null;
  const criterionInputs = new Map<number, HTMLInputElement>();

  function contextFingerprint(value: JudgeContext): string {
    return [value.activity_id, value.round_id, value.seat_id, value.panel_snapshot_id,
      value.panel_version, value.context_version, value.performance_id ?? "none"].join(":");
  }

  function storageKey(fingerprint: string): string {
    return `${storageKeyPrefix}${fingerprint}`;
  }

  function validDraftCriteria(value: unknown): value is Record<string, string> {
    if (!isRecord(value)) return false;
    const entries = Object.entries(value);
    return entries.length <= 100 && entries.every(([key, item]) =>
      /^\d+$/.test(key) && typeof item === "string" && item.length <= 16);
  }

  function parseDraft(value: unknown, fingerprint: string): Draft | null {
    if (!isRecord(value) || typeof value.command_id !== "string" ||
      value.context_fingerprint !== fingerprint || !isRecord(value.score_payload) ||
      typeof value.score_payload.score !== "string" ||
      typeof value.score_payload.notes !== "string" ||
      value.command_id.length === 0 || value.command_id.length > 64 ||
      value.score_payload.score.length > 16 || value.score_payload.notes.length > 200) return null;
    const criteria = value.score_payload.criteria === undefined ? {} : value.score_payload.criteria;
    if (!validDraftCriteria(criteria)) return null;
    return {
      command_id: value.command_id,
      context_fingerprint: fingerprint,
      score_payload: {
        score: value.score_payload.score,
        notes: value.score_payload.notes,
        criteria,
      },
    };
  }

  function readDraft(fingerprint: string): Draft | null {
    const storage = localStorageOrNull();
    if (!storage) return null;
    try {
      const scoped = JSON.parse(storage.getItem(storageKey(fingerprint)) || "null");
      const parsedScoped = parseDraft(scoped, fingerprint);
      if (parsedScoped) return parsedScoped;
      return parseDraft(JSON.parse(storage.getItem(legacyStorageKey) || "null"), fingerprint);
    } catch {
      return null;
    }
  }

  function trimDrafts(storage: Storage, currentKey: string): void {
    if (typeof storage.length !== "number" || typeof storage.key !== "function") return;
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(storageKeyPrefix)) keys.push(key);
    }
    for (const key of keys.slice(0, Math.max(0, keys.length - maxDrafts))) {
      if (key !== currentKey) storage.removeItem(key);
    }
  }

  function persistDraft(value: Draft): void {
    const storage = localStorageOrNull();
    if (!storage) return;
    try {
      const serialized = JSON.stringify(value);
      const currentKey = storageKey(value.context_fingerprint);
      storage.setItem(currentKey, serialized);
      storage.setItem(legacyStorageKey, serialized);
      trimDrafts(storage, currentKey);
    } catch {
      // A local draft is a convenience and never changes server authority.
    }
  }

  function clearDraft(value: Draft): void {
    const storage = localStorageOrNull();
    if (!storage) return;
    try {
      storage.removeItem(storageKey(value.context_fingerprint));
      const legacy = parseDraft(
        JSON.parse(storage.getItem(legacyStorageKey) || "null"),
        value.context_fingerprint,
      );
      if (legacy?.command_id === value.command_id) storage.removeItem(legacyStorageKey);
    } catch {
      // Ignore storage privacy/quota failures.
    }
  }

  function draftPayload(): DraftPayload {
    const criteria: Record<string, string> = {};
    for (const [criterionId, input] of criterionInputs) criteria[String(criterionId)] = input.value;
    return {
      score: scoreField.value,
      notes: notesField?.value || "",
      criteria,
    };
  }

  function ensureDraft(): Draft | null {
    if (!context) return null;
    if (!draft || draft.context_fingerprint !== contextFingerprint(context)) {
      draft = {
        command_id: commandId(),
        context_fingerprint: contextFingerprint(context),
        score_payload: draftPayload(),
      };
    } else {
      draft.score_payload = draftPayload();
    }
    return draft;
  }

  function persistCurrentDraft(): void {
    const current = ensureDraft();
    if (current) persistDraft(current);
  }

  function scheduleDraftPersistence(): void {
    if (draftTimer !== null) clearTimeout(draftTimer);
    draftTimer = setTimeout(() => {
      draftTimer = null;
      persistCurrentDraft();
    }, 200);
  }

  function clearVisibleDraft(): void {
    scoreField.value = "";
    if (notesField) notesField.value = "";
    for (const input of criterionInputs.values()) input.value = "";
  }

  function updateTotal(): void {
    if (!totalField || !context || context.rubric_payload.criteria.length === 0) return;
    const values = context.rubric_payload.criteria.map((criterion) => {
      const input = criterionInputs.get(criterion.criterion_id);
      return input ? Number(input.value.trim()) : Number.NaN;
    });
    totalField.textContent = values.every((value) => Number.isFinite(value))
      ? values.reduce((sum, value) => sum + value, 0).toFixed(2)
      : "—";
  }

  function applyDraft(value: Draft | null): void {
    clearVisibleDraft();
    if (!value) return;
    scoreField.value = value.score_payload.score;
    if (notesField) notesField.value = value.score_payload.notes;
    for (const [criterionId, input] of criterionInputs) {
      input.value = value.score_payload.criteria[String(criterionId)] || "";
    }
    updateTotal();
  }

  function renderContext(value: JudgeContext): void {
    if (roundField) roundField.textContent = value.round_name;
    if (performanceField) performanceField.textContent = value.performance_label || "暂无";
    if (singerField) singerField.textContent = value.singer_name || "暂无";
    if (songField) songField.textContent = value.song_title || "暂无";
    if (stateField) {
      stateField.textContent = ({
        performing: "评分中",
        accepting_score: "等待收分",
        hold: "现场暂停",
        idle: "等待开始",
      } as Record<string, string>)[value.performance_state] || "当前状态";
    }
    criterionInputs.clear();
    if (criteriaContainer) criteriaContainer.replaceChildren();
    for (const criterion of value.rubric_payload.criteria) {
      const label = document.createElement("label");
      label.textContent = `${criterion.name}（最高 ${criterion.max_score}）`;
      if (criterion.description) {
        const description = document.createElement("span");
        description.textContent = `：${criterion.description}`;
        label.appendChild(description);
      }
      const input = document.createElement("input");
      input.type = "text";
      input.inputMode = "decimal";
      input.autocomplete = "off";
      input.dataset.criterionId = String(criterion.criterion_id);
      input.addEventListener("input", () => {
        updateTotal();
        scheduleDraftPersistence();
      });
      label.appendChild(input);
      criterionInputs.set(criterion.criterion_id, input);
      criteriaContainer?.appendChild(label);
    }
    scoreField.disabled = value.rubric_payload.criteria.length > 0;
    if (totalField) totalField.textContent = "—";
  }

  function updateControls(): void {
    const scoreable = context !== null && context.performance_id !== null &&
      ["performing", "accepting_score"].includes(context.performance_state);
    submitControl.disabled = !scoreable;
    if (context && context.rubric_payload.criteria.length > 0) scoreField.disabled = true;
  }

  function setContext(value: JudgeContext, initial = false): void {
    const oldFingerprint = context ? contextFingerprint(context) : null;
    const newFingerprint = contextFingerprint(value);
    const changed = oldFingerprint !== null && oldFingerprint !== newFingerprint;
    if (changed && draftTimer !== null) {
      clearTimeout(draftTimer);
      draftTimer = null;
      persistCurrentDraft();
    }
    context = value;
    renderContext(value);
    draft = changed ? null : readDraft(newFingerprint);
    applyDraft(draft);
    updateControls();
    if (changed && !initial) {
      statusText(terminalRoot, "现场上下文已变化，旧草稿已保留，未套用到当前表演。");
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
    if (contextRequest) return contextRequest;
    contextRequest = (async () => {
      const response = await fetch(contextUrl, {
        headers: { Authorization: `Bearer ${token}` },
      });
      return response.ok ? parseContext(await jsonResponse(response)) : null;
    })();
    try {
      return await contextRequest;
    } finally {
      contextRequest = null;
    }
  }

  function schedulePoll(delay = pollDelay): void {
    if (stopped || !sessionToken) return;
    if (pollTimer !== null) clearTimeout(pollTimer);
    pollTimer = setTimeout(() => {
      pollTimer = null;
      void pollContext();
    }, delay);
  }

  async function refreshContext(): Promise<void> {
    if (!sessionToken) return;
    const refreshed = await loadContext(sessionToken);
    if (refreshed) setContext(refreshed);
  }

  async function pollContext(): Promise<void> {
    if (!sessionToken || pollInFlight || stopped) return;
    pollInFlight = true;
    try {
      const refreshed = await loadContext(sessionToken);
      if (!refreshed) {
        sessionToken = null;
        stopped = true;
        statusText(terminalRoot, "评委会话无效或已过期，请重新扫描现场二维码。");
        return;
      }
      const changed = context !== null && contextFingerprint(context) !== contextFingerprint(refreshed);
      setContext(refreshed);
      pollDelay = 2000;
      if (changed) updateControls();
    } catch {
      pollDelay = Math.min(8000, pollDelay * 2);
      statusText(terminalRoot, "网络暂时不可用，当前评分草稿已保留。");
    } finally {
      pollInFlight = false;
      schedulePoll(pollDelay);
    }
  }

  function collectScorePayload(): ScorePayload | null {
    if (!context) return null;
    const criteria = context.rubric_payload.criteria;
    const notes = notesField?.value.trim() || "";
    if (notes.length > 200) return null;
    if (criteria.length === 0) {
      if (!validScore(scoreField.value)) return null;
      return { score: scoreField.value.trim(), notes };
    }
    const values = criteria.map((criterion) => {
      const input = criterionInputs.get(criterion.criterion_id);
      const value = input?.value.trim() || "";
      return { criterion, value };
    });
    if (values.some(({ criterion, value }) => !validCriterionValue(value, criterion))) return null;
    return {
      criteria: values.map(({ criterion, value }) => ({ criterion_id: criterion.criterion_id, value })),
      notes,
    };
  }

  async function submit(): Promise<void> {
    if (!context || !sessionToken) {
      statusText(terminalRoot, "评委会话无效或已过期，请重新扫描现场二维码。");
      return;
    }
    if (!context.performance_id || !["performing", "accepting_score"].includes(context.performance_state)) {
      statusText(terminalRoot, "当前没有可评分的表演。");
      return;
    }
    const scorePayload = collectScorePayload();
    if (!scorePayload) {
      statusText(terminalRoot, "评分内容无效。");
      return;
    }
    if (draftTimer !== null) {
      clearTimeout(draftTimer);
      draftTimer = null;
    }
    const current = ensureDraft();
    if (!current) return;
    current.score_payload = draftPayload();
    persistDraft(current);
    submitControl.disabled = true;
    statusText(terminalRoot, "正在提交评分……");
    try {
      const response = await fetch(scoreUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${sessionToken}` },
        body: JSON.stringify({
          command_id: current.command_id,
          expected_context_version: context.context_version,
          expected_performance_id: context.performance_id,
          score_payload: scorePayload,
        }),
      });
      const data = await jsonResponse(response);
      if (response.ok && parseReceipt(data)) {
        clearDraft(current);
        if (draft?.command_id === current.command_id) draft = null;
        statusText(terminalRoot, "评分已确认。");
      } else if (isRecord(data) && data.reason_code === "STALE_CONTEXT") {
        statusText(terminalRoot, "现场上下文已变化，当前草稿未提交。");
        void refreshContext();
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
      updateControls();
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
      const loadedContext = await loadContext(sessionToken);
      if (!loadedContext) throw new Error("invalid context");
      setContext(loadedContext, true);
      statusText(terminalRoot, "评委终端已就绪。");
      schedulePoll();
    } catch {
      sessionToken = null;
      context = null;
      stopped = true;
      statusText(terminalRoot, "评委会话无效或已过期，请重新扫描现场二维码。");
    }
  }

  scoreField.addEventListener("input", scheduleDraftPersistence);
  notesField?.addEventListener("input", scheduleDraftPersistence);
  submitControl.addEventListener("click", () => { void submit(); });
  window.addEventListener("beforeunload", () => {
    if (draftTimer !== null) {
      clearTimeout(draftTimer);
      draftTimer = null;
      persistCurrentDraft();
    }
    stopped = true;
    if (pollTimer !== null) clearTimeout(pollTimer);
    sessionToken = null;
  });
  void boot();
})();
