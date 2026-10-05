import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(
  new URL("../../static/dist/ticket_check_in.js", import.meta.url),
  "utf8",
);

function fakeClassList() {
  const values = new Set(["hidden"]);
  return {
    values,
    add(...names) {
      names.forEach((name) => values.add(name));
    },
    remove(...names) {
      names.forEach((name) => values.delete(name));
    },
  };
}

function element(extra = {}) {
  return {
    classList: fakeClassList(),
    listeners: new Map(),
    addEventListener(type, listener) {
      this.listeners.set(type, listener);
    },
    ...extra,
  };
}

function boot({ camera = true } = {}) {
  const status = element({ textContent: "", dataset: {} });
  const video = element();
  const photoFallback = element();
  const photoInput = element({ value: "", files: [] });
  const secretInput = element({ value: "" });
  const form = element();
  const elements = new Map([
    ["[data-ticket-camera]", video],
    ["[data-ticket-check-in-status]", status],
    ["[data-ticket-check-in-form]", form],
    ["[name='secret']", secretInput],
    ["[data-ticket-photo-fallback]", photoFallback],
    ["[data-ticket-photo]", photoInput],
    ["[name='csrfmiddlewaretoken']", element({ value: "csrf" })],
  ]);
  const root = element({
    dataset: { checkInUrl: "/staff/tickets/check-in/" },
    querySelector(selector) {
      return elements.get(selector) ?? null;
    },
  });

  const readerCalls = [];
  const context = {
    document: {
      querySelector(selector) {
        return selector === "[data-ticket-check-in-root]" ? root : null;
      },
    },
    window: { location: { origin: "http://192.168.1.20:8000" } },
    navigator: camera ? { mediaDevices: { getUserMedia() {} } } : {},
    URL: { createObjectURL: () => "blob:photo", revokeObjectURL() {} },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ state: "checked_in" }) }),
    ZXingBrowser: {
      BrowserQRCodeReader: class {
        constructor() {
          readerCalls.push("constructed");
        }
        decodeFromVideoDevice() {
          readerCalls.push("video");
          return Promise.resolve();
        }
        decodeFromImageUrl() {
          readerCalls.push("image");
          return Promise.resolve({ getText: () => "ticket-secret" });
        }
      },
    },
    setTimeout,
    clearTimeout,
    console,
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context);
  return { status, photoFallback, readerCalls, root };
}

test("an insecure page offers photo capture instead of a camera that cannot exist", () => {
  const { status, photoFallback, readerCalls } = boot({ camera: false });

  // getUserMedia is absent outside a secure context, so this is the no-ICP LAN fallback.
  assert.equal(photoFallback.classList.values.has("hidden"), false);
  assert.match(status.textContent, /HTTPS/);
  // Nothing tried to open a stream that the browser would never expose.
  assert.deepEqual(readerCalls, []);
});

test("a secure page keeps the live camera and leaves the fallback out of the way", () => {
  const { photoFallback, readerCalls } = boot({ camera: true });

  assert.equal(photoFallback.classList.values.has("hidden"), true);
  assert.deepEqual(readerCalls, ["constructed", "video"]);
});
