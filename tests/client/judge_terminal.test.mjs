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
}

class FakeElement {
  constructor({ dataset = {}, value = "", textContent = "" } = {}) {
    this.dataset = dataset;
    this.value = value;
    this.textContent = textContent;
    this.disabled = false;
    this.listeners = new Map();
    this.children = new Map();
  }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  dispatch(type) { return this.listeners.get(type)?.({ target: this }); }
  querySelector(selector) { return this.children.get(selector) ?? null; }
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
  root.children.set("[data-status]", status);
  root.children.set("[data-score]", score);
  root.children.set("[data-notes]", notes);
  root.children.set("[data-submit]", submit);
  const storage = new FakeStorage();
  const listeners = new Map();
  const window = {
    location: { hash: "#grant-secret", pathname: "/judge/terminal/" },
    history: { replaceState: (_state, _title, pathname) => { window.location.hash = ""; window.location.pathname = pathname; } },
    localStorage: storage,
    addEventListener: (type, listener) => listeners.set(type, listener),
  };
  const crypto = { randomUUID: () => "fixed-command" };
  const context = {
    document: { querySelector: (selector) => selector === "[data-judge-terminal]" ? root : null },
    window,
    crypto,
    fetch: fetchImpl,
    JSON,
    Number,
    Date,
    Math,
    setTimeout,
    clearTimeout,
  };
  vm.runInNewContext(source, context, { filename: "judge_terminal.js" });
  return { root, status, score, notes, submit, storage, window, listeners };
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
    performance_state: "performing",
    rubric_payload: { criteria: [{ name: "音准", max_score: "100.00", sequence: 1 }] },
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
