import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../../static/dist/rapid_score.js", import.meta.url), "utf8");
const pendingKey = "artflow:rapid-score:pending:44:55:7:/staff/rounds/55/scores/api/";

class FakeStorage {
  #values = new Map();

  getItem(key) {
    return this.#values.has(key) ? this.#values.get(key) : null;
  }

  setItem(key, value) {
    this.#values.set(key, String(value));
  }

  removeItem(key) {
    this.#values.delete(key);
  }

  records() {
    return [...this.#values.values()].map((value) => JSON.parse(value));
  }
}

class FakeClassList {
  add() {}
  remove() {}
}

class FakeElement {
  constructor({ dataset = {}, value = "", textContent = "" } = {}) {
    this.dataset = dataset;
    this.value = value;
    this.textContent = textContent;
    this.style = {};
    this.disabled = false;
    this.classList = new FakeClassList();
    this.listeners = new Map();
    this.selectorResults = new Map();
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  dispatch(type, event = {}) {
    this.listeners.get(type)?.({ target: this, ...event });
  }

  querySelector(selector) {
    return this.selectorResults.get(selector) ?? null;
  }

  querySelectorAll() {
    return [];
  }

  closest() {
    return null;
  }

  focus() {}
  select() {}
  blur() {}
}

function grid(score = "", secondScore = null) {
  const cells = [{ judge_id: 9, judge_name: "Judge", score }];
  if (secondScore !== null) cells.push({ judge_id: 10, judge_name: "Judge B", score: secondScore });
  return [{
    singer_id: 1,
    singer_name: "Singer",
    song: "Song",
    cells,
  }];
}

function response(status, data) {
  return { status, json: async () => data };
}

function boot({
  storage = new FakeStorage(),
  online = true,
  fetchImpl,
  initialGrid = grid(),
  operatorId = "7",
} = {}) {
  const input = new FakeElement({ dataset: { singerId: "1", judgeId: "9" } });
  const secondInput = new FakeElement({ dataset: { singerId: "1", judgeId: "10" } });
  const tbody = new FakeElement();
  const container = new FakeElement({
    dataset: {
      apiUrl: "/staff/rounds/55/scores/api/",
      activityId: "44",
      roundId: "55",
      operatorId,
      locked: "false",
    },
  });
  const dataEl = new FakeElement({ textContent: JSON.stringify({ version: 3, grid: initialGrid }) });
  const errorBox = new FakeElement();
  const retryButton = new FakeElement();
  const pendingCount = new FakeElement();
  const savedCount = new FakeElement();
  const conflicts = new FakeElement();

  container.selectorResults.set("tbody", tbody);
  container.selectorResults.set("[data-error]", errorBox);
  container.selectorResults.set("[data-retry]", retryButton);
  container.selectorResults.set("[data-pending-count]", pendingCount);
  container.selectorResults.set("[data-saved-count]", savedCount);
  container.selectorResults.set("[data-conflicts]", conflicts);
  tbody.selectorResults.set('input[data-singer-id="1"][data-judge-id="9"]', input);
  tbody.selectorResults.set('input[data-singer-id="1"][data-judge-id="10"]', secondInput);

  const document = {
    getElementById(id) {
      return { "rapid-entry": container, "rapid-grid-data": dataEl }[id] ?? null;
    },
    querySelector(selector) {
      return selector === '[name="csrfmiddlewaretoken"]' ? new FakeElement({ value: "csrf" }) : null;
    },
  };
  const listeners = new Map();
  let commandNumber = 0;
  const window = {
    localStorage: storage,
    crypto: { randomUUID: () => "test-command-" + (++commandNumber) },
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    dispatch(type, event = {}) {
      return listeners.get(type)?.(event);
    },
  };
  const timers = [];
  const context = {
    document,
    window,
    navigator: { onLine: online },
    fetch: fetchImpl ?? (async () => response(200, { version: 4, matrix_complete: false })),
    setTimeout(callback, delay = 0) {
      const timer = { callback, delay, cancelled: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      timer.cancelled = true;
    },
    Event: class Event { constructor(type, options) { this.type = type; Object.assign(this, options); } },
    JSON,
    Math,
    Date,
    parseFloat,
  };
  vm.runInNewContext(source, context, { filename: "rapid_score.js" });

  return {
    storage,
    window,
    navigator: context.navigator,
    input,
    secondInput,
    tbody,
    retryButton,
    pendingCount,
    savedCount,
    conflicts,
    runTimers() {
      while (timers.length) {
        const timer = timers.shift();
        if (!timer.cancelled) timer.callback();
      }
    },
    runNextTimer() {
      const timer = timers.shift();
      if (timer && !timer.cancelled) timer.callback();
    },
    pendingTimerDelays() {
      return timers.filter((timer) => !timer.cancelled).map((timer) => timer.delay);
    },
  };
}

async function settle() {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

function edit(runtime, value = "90.5") {
  runtime.input.value = value;
  runtime.tbody.dispatch("input", { target: runtime.input });
  runtime.runTimers();
}

function assertPendingRecord(record, {
  score = "90.5",
  commandId = "rapid-test-command-1",
  baseVersion = 3,
  conflicts,
} = {}) {
  const actual = { ...record, updated_at: undefined };
  const expected = {
    activity: 44,
    round: 55,
    endpoint: "/staff/rounds/55/scores/api/",
    base_version: baseVersion,
    cells: [{ singer_id: 1, judge_id: 9, score }],
    command_id: commandId,
    updated_at: undefined,
  };
  if (conflicts === undefined) delete actual.conflicts;
  else expected.conflicts = conflicts;
  assert.deepEqual(actual, expected);
  assert.match(record.updated_at, /^\d{4}-\d{2}-\d{2}T/);
}

test("validated edits persist a pending record before the POST", async () => {
  let recordAtFetch = null;
  const runtime = boot({
    fetchImpl: async () => {
      recordAtFetch = runtime.storage.records()[0] ?? null;
      return response(200, { version: 4, matrix_complete: false });
    },
  });

  edit(runtime);
  await settle();

  assertPendingRecord(recordAtFetch);
  assert.equal(runtime.storage.getItem(pendingKey), null, "matching ACK clears the pending record");
});

test("a network failure retains the pending record", async () => {
  const runtime = boot({ fetchImpl: async () => { throw new Error("offline"); } });

  edit(runtime);
  await settle();

  assert.equal(runtime.storage.records().length, 1);
  assertPendingRecord(runtime.storage.records()[0]);
});

test("a non-acknowledgement response retains the pending record", async () => {
  const runtime = boot({
    fetchImpl: async () => response(400, { detail: ["该单元格不可评分。"], reason_code: "INVALID_REQUEST" }),
  });

  edit(runtime);
  await settle();

  assert.equal(runtime.input.value, "90.5");
  assertPendingRecord(runtime.storage.records()[0]);
});

test("reload restores only this round's pending cells", () => {
  const storage = new FakeStorage();
  storage.setItem(pendingKey, JSON.stringify({
    activity: 44,
    round: 55,
    endpoint: "/staff/rounds/55/scores/api/",
    base_version: 3,
    cells: [{ singer_id: 1, judge_id: 9, score: "88" }],
    command_id: "rapid-reload-command",
    updated_at: "2026-09-05T12:00:00.000Z",
  }));

  const runtime = boot({ storage, initialGrid: grid("70") });

  assert.equal(runtime.input.value, "88");
  assert.equal(runtime.pendingCount.textContent, "1");
});

test("online and manual retry resend a retained pending draft", async () => {
  let calls = 0;
  const runtime = boot({
    online: false,
    fetchImpl: async () => {
      calls += 1;
      return response(200, { version: 4, matrix_complete: false });
    },
  });

  edit(runtime);
  assert.equal(calls, 0, "offline edits wait for an explicit retry opportunity");
  runtime.navigator.onLine = true;
  runtime.window.dispatch("online");
  await settle();
  assert.equal(calls, 1);

  runtime.navigator.onLine = false;
  edit(runtime, "91");
  runtime.runTimers();
  runtime.navigator.onLine = true;
  runtime.retryButton.dispatch("click", { preventDefault() {} });
  await settle();
  assert.equal(calls, 2, "manual retry resends the pending draft");
});

test("pending work warns before unloading the page", async () => {
  const runtime = boot({ fetchImpl: async () => { throw new Error("offline"); } });
  edit(runtime);
  await settle();
  const event = { preventDefault() {} };

  runtime.window.dispatch("beforeunload", event);

  assert.match(event.returnValue, /未保存|保存/);
});

test("pending drafts are isolated by operator identity", () => {
  const storage = new FakeStorage();
  const firstOperator = boot({ storage, operatorId: "7" });
  firstOperator.input.value = "91";
  firstOperator.tbody.dispatch("input", { target: firstOperator.input });
  assert.equal(storage.records().length, 1);
  assert.equal(storage.records()[0].cells[0].score, "91");

  const secondOperator = boot({ storage, operatorId: "8" });
  assert.equal(secondOperator.input.value, "");
  assert.equal(secondOperator.pendingCount.textContent, "0");
});

test("missing operator identity fails closed for pending drafts", () => {
  const storage = new FakeStorage();
  const runtime = boot({ storage, operatorId: "" });

  runtime.input.value = "91";
  runtime.tbody.dispatch("input", { target: runtime.input });

  assert.equal(storage.records().length, 0);
  assert.equal(runtime.pendingCount.textContent, "");
});

test("a stale response rebases a draft when its server cell is unchanged", async () => {
  let requestCount = 0;
  const runtime = boot({
    initialGrid: grid("70", "80"),
    fetchImpl: async (_url, options) => {
      requestCount += 1;
      if (options.method === "POST") {
        return response(409, { conflict: true, reason_code: "STALE_SCORE_VERSION" });
      }
      return response(200, { version: 4, matrix_complete: false, grid: grid("70", "85") });
    },
  });

  edit(runtime, "90");
  await settle();

  assert.equal(requestCount, 2);
  assert.equal(runtime.input.value, "90");
  assert.equal(runtime.secondInput.value, "85");
  assert.equal(runtime.pendingCount.textContent, "1");
  assert.equal(runtime.conflicts.textContent, "");
  assertPendingRecord(runtime.storage.records()[0], { score: "90", baseVersion: 4 });
  assert.equal(runtime.storage.records()[0].base_version, 4);
});

test("a stale divergent cell retains both values as an explicit conflict", async () => {
  const runtime = boot({
    initialGrid: grid("70"),
    fetchImpl: async (_url, options) => {
      if (options.method === "POST") {
        return response(409, { conflict: true, reason_code: "STALE_SCORE_VERSION" });
      }
      return response(200, { version: 4, matrix_complete: false, grid: grid("95") });
    },
  });

  edit(runtime, "90");
  await settle();

  assert.equal(runtime.input.value, "90");
  assert.equal(runtime.pendingCount.textContent, "1", "409 must not clear the draft");
  assert.match(runtime.conflicts.textContent, /90/);
  assert.match(runtime.conflicts.textContent, /95/);
  assertPendingRecord(runtime.storage.records()[0], {
    score: "90",
    baseVersion: 4,
    conflicts: [{ singer_id: 1, judge_id: 9, base: "70", server: "95", local: "90" }],
  });
});

test("a reloaded divergent draft retains both values and blocks retry until edited", async () => {
  const storage = new FakeStorage();
  const runtime = boot({
    storage,
    initialGrid: grid("70"),
    fetchImpl: async (_url, options) => {
      if (options.method === "POST") {
        return response(409, { conflict: true, reason_code: "STALE_SCORE_VERSION" });
      }
      return response(200, { version: 4, matrix_complete: false, grid: grid("95") });
    },
  });

  edit(runtime, "90");
  await settle();
  assert.deepEqual(storage.records()[0].conflicts, [{
    singer_id: 1,
    judge_id: 9,
    base: "70",
    server: "95",
    local: "90",
  }]);

  let retryCalls = 0;
  const reloaded = boot({
    storage,
    initialGrid: grid("95"),
    fetchImpl: async () => {
      retryCalls += 1;
      return response(200, { version: 5, matrix_complete: false });
    },
  });
  reloaded.retryButton.dispatch("click", { preventDefault() {} });
  await settle();

  assert.equal(reloaded.input.value, "90");
  assert.match(reloaded.conflicts.textContent, /90/);
  assert.match(reloaded.conflicts.textContent, /95/);
  assert.equal(reloaded.pendingCount.textContent, "1");
  assert.equal(retryCalls, 0, "reload must not turn a conflict into an overwrite");
});

test("network retries use an exponential delay capped at eight seconds", async () => {
  let calls = 0;
  const runtime = boot({
    fetchImpl: async () => {
      calls += 1;
      throw new Error("offline");
    },
  });

  edit(runtime);
  await settle();
  assert.equal(calls, 1);
  assert.deepEqual(runtime.pendingTimerDelays(), [1000]);

  for (const expectedDelay of [2000, 4000, 8000, 8000]) {
    runtime.runNextTimer();
    await settle();
    assert.deepEqual(runtime.pendingTimerDelays(), [expectedDelay]);
  }
});
