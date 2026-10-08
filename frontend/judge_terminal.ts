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
    activity_name: string;
    round_id: number;
    round_name: string;
    seat_id: number;
    seat_label: string;
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
      typeof candidate.activity_name !== "string" ||
      !positiveInteger(candidate.round_id) ||
      typeof candidate.round_name !== "string" ||
      !positiveInteger(candidate.seat_id) ||
      typeof candidate.seat_label !== "string" ||
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
      activity_name: candidate.activity_name,
      round_id: candidate.round_id,
      round_name: candidate.round_name,
      seat_id: candidate.seat_id,
      seat_label: candidate.seat_label,
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

  function statusText(
    root: HTMLElement,
    message: string,
    tone: "info" | "success" | "error" = "info",
  ): void {
    const element = root.querySelector<HTMLElement>("[data-status]");
    if (!element) return;
    element.textContent = message;
    element.dataset.statusTone = tone;
    element.classList.remove("border-gray-200", "bg-gray-50", "text-gray-700", "border-green-200", "bg-green-50", "text-green-800", "border-red-200", "bg-red-50", "text-red-800");
    const classes = tone === "success"
      ? ["border-green-200", "bg-green-50", "text-green-800"]
      : tone === "error"
        ? ["border-red-200", "bg-red-50", "text-red-800"]
        : ["border-gray-200", "bg-gray-50", "text-gray-700"];
    element.classList.add(...classes);
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
  const seatField = root.querySelector<HTMLElement>("[data-seat-label]");
  const activityField = root.querySelector<HTMLElement>("[data-activity]");
  const performanceField = root.querySelector<HTMLElement>("[data-performance-label]");
  const singerField = root.querySelector<HTMLElement>("[data-singer]");
  const songField = root.querySelector<HTMLElement>("[data-song]");
  const stateField = root.querySelector<HTMLElement>("[data-performance-state]");
  const criteriaContainer = root.querySelector<HTMLElement>("[data-criteria]");
  const totalField = root.querySelector<HTMLElement>("[data-total]");

  const redeemUrl = root.dataset.redeemUrl || "/entry-access/grants/redeem/";
  const claimUrl = root.dataset.claimUrl || "/judge/claim/";
  const contextUrl = root.dataset.contextUrl || "/judge/context/";
  const scoreUrl = root.dataset.scoreUrl || "/judge/score/";
  const wsUrl = root.dataset.wsUrl || "/ws/judge/";
  const legacyStorageKey = "artflow:judge:draft";
  const storageKeyPrefix = "artflow:judge:draft:";
  const maxDrafts = 8;
  let sessionToken: string | null = null;
  let cookieSession = false;
  let context: JudgeContext | null = null;
  let draft: Draft | null = null;
  let draftTimer: number | null = null;
  let pollTimer: number | null = null;
  let pollInFlight = false;
  let pollDelay = 2000;
  let stopped = false;
  let contextRequest: Promise<JudgeContext | null> | null = null;
  let realtimeSocket: WebSocket | null = null;
  let realtimeReconnectTimer: number | null = null;
  let realtimeHeartbeatTimer: number | null = null;
  let realtimeReconnectDelay = 1000;
  let realtimeConnected = false;
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
    if (activityField) activityField.textContent = value.activity_name;
    if (roundField) roundField.textContent = value.round_name;
    if (seatField) seatField.textContent = value.seat_label;
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
      input.type = "number";
      input.min = "0";
      input.max = criterion.max_score;
      input.step = "0.01";
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

  // The three ways the door can turn a teacher away — a full panel (§12.3), a paused one
  // (§12.6), and a round with no panel yet — used to arrive as one "terminals full", which
  // sent someone whose panel was merely paused hunting for an occupied seat.
  const CLAIM_FAILURE_MESSAGES: Record<string, string> = {
    JUDGE_TERMINALS_FULL: "评委席已满，请联系现场工作人员处理。",
    PANEL_NOT_READY: "评委组尚未准备，请等待现场工作人员。",
    ROUND_ON_HOLD: "现场评分已暂停，请等待工作人员恢复。",
  };

  class ClaimRejected extends Error {
    readonly reasonCode: string;

    constructor(reasonCode: string) {
      super(reasonCode);
      this.reasonCode = reasonCode;
    }
  }

  function claimFailureMessage(error: unknown): string {
    if (error instanceof ClaimRejected) {
      return (
        CLAIM_FAILURE_MESSAGES[error.reasonCode] ?? "未能加入评委组，请联系现场工作人员。"
      );
    }
    return "评委会话无效或已过期，请重新扫描现场二维码。";
  }

  async function claim(): Promise<boolean> {
    const response = await fetch(claimUrl, {
      method: "POST",
      credentials: "same-origin",
    });
    if (response.ok) return true;
    const data = await jsonResponse(response);
    const reasonCode =
      isRecord(data) && typeof data.reason_code === "string" ? data.reason_code : "";
    throw new ClaimRejected(reasonCode);
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
        credentials: "same-origin",
        ...(cookieSession || !token ? {} : { headers: { Authorization: `Bearer ${token}` } }),
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
    try {
      const refreshed = await loadContext(sessionToken);
      if (refreshed) setContext(refreshed);
    } catch {
      // The normal poll remains the fallback when a push-triggered refetch fails.
    }
  }

  function realtimeUrl(): string {
    const url = new URL(wsUrl, window.location.href);
    url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    return url.toString();
  }

  function clearRealtimeTimers(): void {
    if (realtimeReconnectTimer !== null) {
      clearTimeout(realtimeReconnectTimer);
      realtimeReconnectTimer = null;
    }
    if (realtimeHeartbeatTimer !== null) {
      clearInterval(realtimeHeartbeatTimer);
      realtimeHeartbeatTimer = null;
    }
  }

  function scheduleRealtimeReconnect(): void {
    if (stopped || !sessionToken || realtimeReconnectTimer !== null) return;
    realtimeReconnectTimer = setTimeout(() => {
      realtimeReconnectTimer = null;
      connectRealtime();
    }, realtimeReconnectDelay);
    realtimeReconnectDelay = Math.min(10000, realtimeReconnectDelay * 2);
  }

  function closeRealtime(): void {
    clearRealtimeTimers();
    const socket = realtimeSocket;
    realtimeSocket = null;
    realtimeConnected = false;
    if (socket) socket.close();
  }

  function connectRealtime(): void {
    if (stopped || !sessionToken || realtimeSocket !== null || typeof WebSocket === "undefined") return;
    let socket: WebSocket;
    try {
      socket = new WebSocket(realtimeUrl());
    } catch {
      scheduleRealtimeReconnect();
      return;
    }
    realtimeSocket = socket;
    socket.addEventListener("open", () => {
      if (realtimeSocket !== socket) return;
      realtimeConnected = true;
      realtimeReconnectDelay = 1000;
      pollDelay = 2000;
      if (realtimeHeartbeatTimer !== null) clearInterval(realtimeHeartbeatTimer);
      realtimeHeartbeatTimer = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "heartbeat" }));
      }, 15000);
      schedulePoll(30000);
    });
    socket.addEventListener("message", (event) => {
      let payload: unknown;
      try {
        payload = JSON.parse(event.data as string);
      } catch {
        return;
      }
      if (!isRecord(payload) || payload.type !== "judge.context_changed") return;
      void refreshContext();
    });
    socket.addEventListener("error", () => {
      if (realtimeSocket === socket) socket.close();
    });
    socket.addEventListener("close", () => {
      if (realtimeSocket !== socket) return;
      realtimeSocket = null;
      realtimeConnected = false;
      clearRealtimeTimers();
      schedulePoll(2000);
      scheduleRealtimeReconnect();
    });
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
      schedulePoll(realtimeConnected ? 30000 : pollDelay);
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
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          ...(cookieSession || !sessionToken
            ? {}
            : { Authorization: `Bearer ${sessionToken}` }),
        },
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
        statusText(
          terminalRoot,
          `评分已确认：${context.singer_name || "当前选手"}，等待现场切换下一位选手。`,
          "success",
        );
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
    try {
      if (fragment) {
        window.history.replaceState(null, "", window.location.pathname);
        sessionToken = await redeem(decodeURIComponent(fragment));
        if (!sessionToken) throw new Error("invalid grant");
        cookieSession = false;
      } else {
        // `claim()` throws ClaimRejected with the server's reason code, so the catch below
        // can tell a full panel from a paused one.
        await claim();
        sessionToken = "cookie";
        cookieSession = true;
      }
      const loadedContext = await loadContext(sessionToken);
      if (!loadedContext) throw new Error("invalid context");
      setContext(loadedContext, true);
      statusText(terminalRoot, "评委终端已就绪。");
      connectRealtime();
      schedulePoll(realtimeConnected ? 30000 : pollDelay);
    } catch (error) {
      sessionToken = null;
      context = null;
      stopped = true;
      statusText(terminalRoot, claimFailureMessage(error));
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
    closeRealtime();
    sessionToken = null;
  });
  void boot();
})();
