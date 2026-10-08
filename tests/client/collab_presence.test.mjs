import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../../static/dist/collab_presence.js", import.meta.url), "utf8");

class FakeElement {
  constructor(tag = "div") {
    this.tag = tag;
    this.className = "";
    this.textContent = "";
    this.hidden = false;
    this.dataset = {};
    this.children = [];
    this.listeners = new Map();
  }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  dispatch(type, event) { this.listeners.get(type)?.(event); }
  append(child) { this.children.push(child); }
  replaceChildren(...children) { this.children = children; }
}

class FakeSocket {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.sent = [];
    this.readyState = 1;
    this.listeners = new Map();
    FakeSocket.instances.push(this);
  }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  emit(type, event) { this.listeners.get(type)?.(event); }
  send(payload) { this.sent.push(payload); }
  close() { this.readyState = 3; }
}
FakeSocket.OPEN = 1;

function boot({ dataset = {}, withRoot = true, insecure = false } = {}) {
  const membersList = new FakeElement("ul");
  const status = new FakeElement("p");
  const refreshBanner = new FakeElement("div");
  refreshBanner.hidden = true;
  const refreshAction = new FakeElement("button");
  const reloads = [];

  const root = new FakeElement();
  root.dataset = {
    collabWsUrl: "/ws/group/3/materials/",
    collabResource: "group:3:materials",
    ...dataset,
  };
  root.querySelector = (selector) =>
    ({
      "[data-collab-members]": membersList,
      "[data-collab-status]": status,
      "[data-collab-refresh]": refreshBanner,
      "[data-collab-refresh-action]": refreshAction,
    })[selector] ?? null;

  FakeSocket.instances = [];
  const context = {
    document: {
      querySelector: (selector) => (withRoot && selector === "[data-collab-presence]" ? root : null),
      createElement: (tag) => new FakeElement(tag),
    },
    window: {
      location: { origin: "http://localhost", protocol: "http:", reload: () => reloads.push(true) },
      sessionStorage: { getItem: () => null, setItem: () => {} },
      addEventListener: () => {},
      setInterval: () => 1,
      clearInterval: () => {},
      setTimeout: () => 1,
      clearTimeout: () => {},
    },
    crypto: { randomUUID: () => "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" },
    URL,
    WebSocket: FakeSocket,
  };

  if (insecure) delete context.crypto;

  vm.runInNewContext(source, context);
  return { membersList, status, refreshBanner, refreshAction, reloads, root };
}

test("group material page uses its own empty-state wording", () => {
  const runtime = boot({ dataset: { collabEmptyText: "当前没有其他组员在线" } });

  assert.equal(runtime.membersList.children.length, 1);
  assert.equal(runtime.membersList.children[0].textContent, "当前没有其他组员在线");
});

test("the staff workspace wording is unchanged when no override is supplied", () => {
  const runtime = boot();

  assert.equal(runtime.membersList.children[0].textContent, "当前没有其他工作人员在线");
});

test("a presence snapshot lists the current members", () => {
  const runtime = boot({ dataset: { collabEmptyText: "当前没有其他组员在线" } });
  const socket = FakeSocket.instances[0];

  socket.emit("message", {
    data: JSON.stringify({
      type: "presence.snapshot",
      members: [{ client_id: "b", display: "李四" }],
    }),
  });

  assert.equal(runtime.membersList.children.length, 1);
  assert.equal(runtime.membersList.children[0].children[0].textContent, "李四");
});

test("a business material event reveals the refresh banner", () => {
  const runtime = boot({
    dataset: { collabRefreshEvents: "group.material_changed,group.material_reviewed" },
  });
  const socket = FakeSocket.instances[0];

  assert.equal(runtime.refreshBanner.hidden, true);
  socket.emit("message", { data: JSON.stringify({ type: "group.material_changed" }) });
  assert.equal(runtime.refreshBanner.hidden, false);
});

test("an unrelated realtime event does not reveal the refresh banner", () => {
  const runtime = boot({ dataset: { collabRefreshEvents: "group.material_changed" } });
  const socket = FakeSocket.instances[0];

  socket.emit("message", { data: JSON.stringify({ type: "judge.context_changed" }) });
  assert.equal(runtime.refreshBanner.hidden, true);
});

test("the refresh banner action reloads the authoritative page", () => {
  const runtime = boot();

  runtime.refreshAction.dispatch("click");
  assert.equal(runtime.reloads.length, 1);
});

test("a page without the collaboration root is untouched", () => {
  const runtime = boot({ withRoot: false });

  assert.equal(runtime.membersList.children.length, 0);
  assert.equal(FakeSocket.instances.length, 0);
});

test("an insecure context boots without crypto.randomUUID", () => {
  // `randomUUID` exists only in a secure context, and the no-ICP LAN fallback
  // (`http://192.168.x.x:8000`) is exactly where the presence panel has to work. The bare
  // call threw a TypeError before the first heartbeat and the panel never appeared.
  const runtime = boot({ insecure: true });

  assert.equal(runtime.membersList.children.length, 1);
  assert.match(FakeSocket.instances[0].url, /^ws:\/\/localhost\/ws\/group\/3\/materials\/\?client_id=/);
});
