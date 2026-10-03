import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../../static/dist/activity_live.js", import.meta.url), "utf8");

class FakeClassList {
  constructor() {
    this.values = new Set();
  }
  toggle(name, force) {
    if (force) this.values.add(name);
    else this.values.delete(name);
  }
  contains(name) {
    return this.values.has(name);
  }
}

class FakeElement {
  constructor() {
    this.dataset = {};
    this.textContent = "";
    this.href = "";
    this.classList = new FakeClassList();
    this.children = new Map();
  }
  querySelector(selector) {
    return this.children.get(selector) ?? null;
  }
}

function response(status, data) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}

async function settle() {
  for (let index = 0; index < 40; index += 1) await Promise.resolve();
}

function boot(fetchImpl, { random = () => 0 } = {}) {
  const root = new FakeElement();
  root.dataset.stateUrl = "/e/ABCDEFGH/live/state/";
  const voteSection = new FakeElement();
  const waitingSection = new FakeElement();
  const voteName = new FakeElement();
  const voteLabel = new FakeElement();
  const voteLink = new FakeElement();
  const ticketStatus = new FakeElement();
  root.children.set("[data-live-vote-section]", voteSection);
  root.children.set("[data-live-waiting]", waitingSection);
  root.children.set("[data-live-vote-name]", voteName);
  root.children.set("[data-live-vote-label]", voteLabel);
  root.children.set("[data-live-vote-link]", voteLink);
  root.children.set("[data-live-ticket-status]", ticketStatus);

  const documentListeners = new Map();
  const windowListeners = new Map();
  const timers = new Map();
  let timerId = 0;
  let clock = 0;
  const setTimer = (callback, delay = 0) => {
    const id = ++timerId;
    timers.set(id, { callback, due: clock + Math.max(0, delay) });
    return id;
  };
  const clearTimer = (id) => {
    timers.delete(id);
  };
  const document = {
    hidden: false,
    querySelector: (selector) => (selector === "[data-live-surface]" ? root : null),
    addEventListener: (type, listener) => documentListeners.set(type, listener),
  };
  const window = {
    addEventListener: (type, listener) => windowListeners.set(type, listener),
    setTimeout: setTimer,
    clearTimeout: clearTimer,
  };
  const math = Object.create(Math);
  math.random = random;
  const context = {
    document,
    window,
    fetch: fetchImpl,
    JSON,
    Number,
    Math: math,
  };
  vm.runInNewContext(source, context, { filename: "activity_live.js" });

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

  return {
    root,
    voteName,
    voteLabel,
    voteLink,
    ticketStatus,
    document,
    window,
    timers,
    advance,
    pendingDelays: () => [...timers.values()].map((timer) => timer.due - clock),
    async dispatchVisibility() {
      documentListeners.get("visibilitychange")?.();
      await settle();
    },
  };
}

const waitingPayload = {
  revision: "r1",
  state: "waiting",
  label: "当前暂无开放投票",
  vote_name: "",
  ticket_status: "unrecognized",
};

test("normal polling is jittered inside the 2.2-2.8 s window", async () => {
  const calls = [];
  const high = boot(
    async () => {
      calls.push(1);
      return response(200, waitingPayload);
    },
    { random: () => 1 },
  );
  await settle();
  assert.equal(calls.length, 1);
  assert.deepEqual(high.pendingDelays(), [2800]);

  const low = boot(async () => response(200, waitingPayload), { random: () => 0 });
  await settle();
  assert.deepEqual(low.pendingDelays(), [2200]);
});

test("failed polls climb 2.5/5/8/10 s and the next success restores normal cadence", async () => {
  let failing = true;
  const runtime = boot(async () => {
    if (failing) throw new Error("offline");
    return response(200, waitingPayload);
  });
  await settle();

  const ladder = [];
  for (let index = 0; index < 5; index += 1) {
    assert.equal(runtime.pendingDelays().length, 1);
    const delay = runtime.pendingDelays()[0];
    ladder.push(delay);
    await runtime.advance(delay);
  }
  assert.deepEqual(ladder, [2500, 5000, 8000, 10000, 10000]);

  failing = false;
  await runtime.advance(10000);

  assert.deepEqual(runtime.pendingDelays(), [2200]);
});

test("an unsuccessful response counts as a failure", async () => {
  const runtime = boot(async () => response(503, {}));
  await settle();

  assert.deepEqual(runtime.pendingDelays(), [2500]);
});

test("a hidden page slows to 10-15 s and becoming visible refreshes immediately", async () => {
  const calls = [];
  const runtime = boot(async () => {
    calls.push(1);
    return response(200, waitingPayload);
  });
  await settle();
  assert.deepEqual(runtime.pendingDelays(), [2200]);

  runtime.document.hidden = true;
  await runtime.advance(2200);
  assert.equal(calls.length, 2);
  const hiddenDelay = runtime.pendingDelays()[0];
  assert.ok(
    hiddenDelay >= 10000 && hiddenDelay <= 15000,
    `unexpected hidden-tab delay ${hiddenDelay}`,
  );

  runtime.document.hidden = false;
  await runtime.dispatchVisibility();

  assert.equal(calls.length, 3);
  assert.deepEqual(runtime.pendingDelays(), [2200]);
});

test("visibility changes never leave two timers or two concurrent polls", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const runtime = boot(async () => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await gate;
    inFlight -= 1;
    return response(200, waitingPayload);
  });
  await settle();
  assert.equal(maxInFlight, 1);

  runtime.document.hidden = true;
  await runtime.dispatchVisibility();
  runtime.document.hidden = false;
  await runtime.dispatchVisibility();
  await runtime.dispatchVisibility();

  assert.equal(maxInFlight, 1);
  assert.ok(runtime.timers.size <= 1, `expected at most one timer, got ${runtime.timers.size}`);

  release();
  await settle();

  assert.equal(runtime.timers.size, 1);
  assert.equal(maxInFlight, 1);
});

test("renders the shared and personal halves of the payload", async () => {
  const runtime = boot(async () =>
    response(200, {
      revision: "r1",
      state: "open",
      label: "投票进行中",
      vote_name: "人气投票",
      vote_url: "/vote/3/",
      ticket_status: "checked_in",
    }),
  );
  await settle();

  assert.equal(runtime.voteName.textContent, "人气投票");
  assert.equal(runtime.voteLabel.textContent, "投票进行中");
  assert.equal(runtime.voteLink.href, "/vote/3/");
  assert.match(runtime.ticketStatus.textContent, /已检票/);
});

test("an unchanged revision does not repaint", async () => {
  let label = "第一次";
  const runtime = boot(async () => response(200, { ...waitingPayload, label }));
  await settle();
  assert.equal(runtime.voteLabel.textContent, "第一次");

  label = "第二次";
  await runtime.advance(2200);

  assert.equal(runtime.voteLabel.textContent, "第一次");
});
