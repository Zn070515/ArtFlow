import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../../static/dist/judge_terminal.js", import.meta.url), "utf8");

class FakeStorage {
  #values = new Map();
  getItem(key) { return this.#values.get(key) ?? null; }
  setItem(key, value) { this.#values.set(key, String(value)); }
  removeItem(key) { this.#values.delete(key); }
  value(key) { return this.#values.get(key) ?? null; }
  entries() { return [...this.#values.entries()]; }
}

class FakeElement {
  constructor({ dataset = {}, value = "", textContent = "" } = {}) {
    this.dataset = dataset;
    this.value = value;
    this.textContent = textContent;
    this.disabled = false;
    this.listeners = new Map();
    this.children = new Map();
    this.childList = [];
  }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  dispatch(type) { return this.listeners.get(type)?.({ target: this }); }
  querySelector(selector) { return this.children.get(selector) ?? null; }
  querySelectorAll(selector) {
    if (this.children.has(selector)) return this.children.get(selector);
    if (selector === "[data-criterion-id]") {
      return this.childList.flatMap((child) => [
        ...(child.dataset.criterionId ? [child] : []),
        ...child.querySelectorAll(selector),
      ]);
    }
    return [];
  }
  appendChild(child) { this.childList.push(child); return child; }
  replaceChildren(...children) { this.childList = children; }
  setAttribute(name, value) {
    if (name === "data-criterion-id") this.dataset.criterionId = String(value);
    this[name] = String(value);
  }
}

function response(status, data) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}

function boot(fetchImpl) {
  const root = new FakeElement({ dataset: {
    redeemUrl: "/entry-access/grants/redeem/",
    contextUrl: "/judge/context/",
    scoreUrl: "/judge/score/",
  } });
  const status = new FakeElement();
  const score = new FakeElement();
  const notes = new FakeElement();
  const submit = new FakeElement();
  const round = new FakeElement();
  const performance = new FakeElement();
  const singer = new FakeElement();
  const song = new FakeElement();
  const criteria = new FakeElement();
  const total = new FakeElement();
  root.children.set("[data-status]", status);
  root.children.set("[data-score]", score);
  root.children.set("[data-notes]", notes);
  root.children.set("[data-submit]", submit);
  root.children.set("[data-round]", round);
  root.children.set("[data-performance-label]", performance);
  root.children.set("[data-singer]", singer);
  root.children.set("[data-song]", song);
  root.children.set("[data-criteria]", criteria);
  root.children.set("[data-total]", total);
  const storage = new FakeStorage();
  const listeners = new Map();
  const timers = new Map();
  let timerId = 0;
  let clock = 0;
  const setTimer = (callback, delay = 0) => {
    const id = ++timerId;
    timers.set(id, { callback, due: clock + Math.max(0, delay) });
    return id;
  };
  const clearTimer = (id) => { timers.delete(id); };
  async function advance(ms) {
    clock += ms;
    while (true) {
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.due <= clock)
        .sort(([, left], [, right]) => left.due - right.due);
      if (due.length === 0) break;
      const [id, timer] = due[0];
      timers.delete(id);
      timer.callback();
      await settle();
    }
  }
  const window = {
    location: { hash: "#grant-secret", pathname: "/judge/terminal/" },
    history: { replaceState: (_state, _title, pathname) => { window.location.hash = ""; window.location.pathname = pathname; } },
    localStorage: storage,
    addEventListener: (type, listener) => listeners.set(type, listener),
  };
  const crypto = { randomUUID: () => "fixed-command" };
  const context = {
    document: {
      querySelector: (selector) => selector === "[data-judge-terminal]" ? root : null,
      createElement: () => new FakeElement(),
    },
    window,
    crypto,
    fetch: fetchImpl,
    JSON,
    Number,
    Date,
    Math,
    setTimeout: setTimer,
    clearTimeout: clearTimer,
  };
  vm.runInNewContext(source, context, { filename: "judge_terminal.js" });
  return {
    root, status, score, notes, submit, round, performance, singer, song, criteria, total,
    storage, window, listeners, advance,
  };
}

const contextPayload = {
  context: {
    activity_id: 1,
    round_id: 2,
    seat_id: 3,
    panel_snapshot_id: 4,
    panel_version: 1,
    context_version: 5,
    performance_id: 6,
    round_name: "决赛",
    performance_label: "第 6 个节目",
    singer_name: "参赛者",
    song_title: "曲目",
    performance_state: "performing",
    rubric_payload: {},
  },
};

const rubricContextPayload = {
  context: {
    ...contextPayload.context,
    rubric_payload: {
      name: "评分表",
      criteria: [{ criterion_id: 12, name: "音准", description: "音准表现", max_score: "100.00", sequence: 1 }],
    },
  },
};

const nextContextPayload = {
  context: {
    ...contextPayload.context,
    context_version: 6,
    performance_id: 7,
    performance_label: "第 7 个节目",
    singer_name: "下一位参赛者",
    song_title: "下一首曲目",
  },
};

async function settle() {
  for (let index = 0; index < 40; index += 1) await Promise.resolve();
}

test("redeems the fragment in memory and never stores the session token", async () => {
  const calls = [];
  const runtime = boot(async (url, options = {}) => {
    calls.push({ url, options });
    if (url.includes("redeem")) return response(200, { kind: "judge", session_token: "session-secret" });
    return response(200, contextPayload);
  });
  await settle();

  assert.equal(runtime.status.textContent, "评委终端已就绪。");
  assert.equal(runtime.window.location.hash, "");
  assert.equal(runtime.storage.value("artflow:judge:draft"), null);
  assert.deepEqual(JSON.parse(calls[0].options.body), { token: "grant-secret" });
  assert.equal(calls[1].options.headers.Authorization, "Bearer session-secret");
});

test("network failure persists only a bounded draft and retry keeps its command", async () => {
  let scoreCalls = 0;
  const runtime = boot(async (url) => {
    if (url.includes("redeem")) return response(200, { kind: "judge", session_token: "session-secret" });
    if (url.includes("context")) return response(200, contextPayload);
    scoreCalls += 1;
    throw new Error("offline");
  });
  await settle();
  runtime.score.value = "91.50";
  runtime.notes.value = "现场备注";
  runtime.submit.dispatch("click");
  await settle();

  const draft = JSON.parse(runtime.storage.value("artflow:judge:draft"));
  assert.equal(scoreCalls, 1);
  assert.deepEqual(Object.keys(draft).sort(), ["command_id", "context_fingerprint", "score_payload"]);
  assert.equal(JSON.stringify(draft).includes("session-secret"), false);
  assert.equal(JSON.stringify(draft).includes("音准"), false);
});

test("stale context is visible and does not clear the draft", async () => {
  let scoreOptions;
  const runtime = boot(async (url, options = {}) => {
    if (url.includes("redeem")) return response(200, { kind: "judge", session_token: "session-secret" });
    if (url.includes("context")) return response(200, contextPayload);
    scoreOptions = options;
    return response(400, { detail: "ignored", reason_code: "STALE_CONTEXT" });
  });
  await settle();
  runtime.score.value = "88";
  runtime.submit.dispatch("click");
  await settle();

  assert.match(runtime.status.textContent, /上下文已变化/);
  assert.ok(runtime.storage.value("artflow:judge:draft"));
  assert.equal(scoreOptions.headers.Authorization, "Bearer session-secret");
});

test("persists a bounded draft after input before submit", async () => {
  const runtime = boot(async (url) => {
    if (url.includes("redeem")) return response(200, { kind: "judge", session_token: "session-secret" });
    return response(200, contextPayload);
  });
  await settle();
  runtime.score.value = "91.50";
  runtime.notes.value = "尚未提交";
  runtime.score.dispatch("input");
  runtime.notes.dispatch("input");
  await runtime.advance(250);

  const serialized = runtime.storage.entries().map(([, value]) => value).join("\n");
  assert.match(serialized, /91\.50/);
  assert.match(serialized, /尚未提交/);
  assert.equal(serialized.includes("session-secret"), false);
  assert.equal(serialized.includes("音准"), false);
});

test("renders server-owned performance display fields", async () => {
  const runtime = boot(async (url) => {
    if (url.includes("redeem")) return response(200, { kind: "judge", session_token: "session-secret" });
    return response(200, contextPayload);
  });
  await settle();

  assert.equal(runtime.round.textContent, "决赛");
  assert.equal(runtime.performance.textContent, "第 6 个节目");
  assert.equal(runtime.singer.textContent, "参赛者");
  assert.equal(runtime.song.textContent, "曲目");
});

test("polls context and isolates old draft when the current performance changes", async () => {
  let contextCalls = 0;
  const runtime = boot(async (url) => {
    if (url.includes("redeem")) return response(200, { kind: "judge", session_token: "session-secret" });
    contextCalls += 1;
    return response(200, contextCalls === 1 ? contextPayload : nextContextPayload);
  });
  await settle();
  runtime.score.value = "88";
  runtime.score.dispatch("input");
  await runtime.advance(250);
  await runtime.advance(2000);

  assert.ok(contextCalls >= 2);
  assert.equal(runtime.performance.textContent, "第 7 个节目");
  assert.equal(runtime.score.value, "");
  assert.match(runtime.status.textContent, /草稿|上下文/);
});

test("submits rubric criterion values without trusting a client total", async () => {
  let scoreOptions;
  const runtime = boot(async (url, options = {}) => {
    if (url.includes("redeem")) return response(200, { kind: "judge", session_token: "session-secret" });
    if (url.includes("context")) return response(200, rubricContextPayload);
    scoreOptions = options;
    return response(201, {
      receipt: { receipt_id: 8, score_record_id: 9, reason_code: "ACCEPTED", status: "succeeded" },
    });
  });
  await settle();
  const criterion = runtime.criteria.querySelectorAll("[data-criterion-id]")[0];
  assert.ok(criterion);
  criterion.value = "91.50";
  criterion.dispatch("input");
  await runtime.advance(250);
  runtime.submit.dispatch("click");
  await settle();

  const submitted = JSON.parse(scoreOptions.body);
  assert.deepEqual(submitted.score_payload, {
    criteria: [{ criterion_id: 12, value: "91.50" }],
    notes: "",
  });
  assert.equal("score" in submitted.score_payload, false);
});
