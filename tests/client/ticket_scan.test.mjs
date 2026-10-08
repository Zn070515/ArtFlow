import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../../static/dist/ticket_scan.js", import.meta.url), "utf8");

function boot({
  hash = "#ticket-secret",
  response = { ok: true, status: 200 },
  ticketState = "issued",
  offline = false,
} = {}) {
  const status = {
    textContent: "",
    dataset: {},
    classList: {
      values: new Set(),
      remove(...names) { names.forEach((name) => this.values.delete(name)); },
      add(...names) { names.forEach((name) => this.values.add(name)); },
    },
  };
  const manualInput = { value: "" };
  const retryButton = {
    hidden: true,
    listeners: new Map(),
    addEventListener(type, listener) { this.listeners.set(type, listener); },
    classList: {
      toggle(name, on) { if (name === "hidden") retryButton.hidden = on; },
    },
    click() { this.listeners.get("click")?.(); },
  };
  const manualForm = {
    listeners: new Map(),
    addEventListener(type, listener) { this.listeners.set(type, listener); },
    dispatch(type) {
      const event = { prevented: false, preventDefault() { this.prevented = true; } };
      this.listeners.get(type)?.(event);
      return event;
    },
  };
  const root = {
    querySelector(selector) {
      if (selector === "[data-ticket-manual-form]") return manualForm;
      if (selector === "[data-ticket-scan-retry]") return retryButton;
      if (selector === "[name='secret']") return manualInput;
      return null;
    },
  };
  const csrf = { value: "csrf-token" };
  const requests = [];
  const historyCalls = [];
  const context = {
    document: {
      querySelector(selector) {
        if (selector === "[data-ticket-scan-root]") return root;
        if (selector === "[data-ticket-scan-status]") return status;
        if (selector === '[name="csrfmiddlewaretoken"]') return csrf;
        return null;
      },
    },
    window: {
      location: { hash, pathname: "/tickets/scan/", search: "?unused=1" },
      history: {
        replaceState(...args) {
          historyCalls.push(args);
        },
      },
    },
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (offline && requests.length === 1) throw new TypeError("network down");
      return { ...response, json: async () => ({ ticket_state: ticketState }) };
    },
    setTimeout,
    console,
  };
  vm.runInNewContext(source, context);
  return { status, requests, historyCalls, manualForm, manualInput, retryButton };
}

test("ticket scan scrubs the fragment before body-only redemption", async () => {
  const result = boot();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(result.historyCalls[0], [null, "", "/tickets/scan/"]);
  assert.equal(result.requests[0].url, "/tickets/redeem/");
  assert.equal(result.requests[0].options.method, "POST");
  assert.equal(result.requests[0].options.headers["X-CSRFToken"], "csrf-token");
  assert.deepEqual(JSON.parse(result.requests[0].options.body), { secret: "ticket-secret" });
  assert.equal(result.status.textContent, "票据已识别。完成现场检票后获得投票资格。");
  assert.equal(result.status.dataset.statusTone, "success");
  assert.equal(result.status.classList.values.has("text-green-800"), true);
});

test("ticket scan explains when a checked-in ticket is eligible", async () => {
  const result = boot({ ticketState: "checked_in" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(
    result.status.textContent,
    "已完成现场检票。你已具备票券投票资格，具体以当前投票场次状态为准。",
  );
  assert.equal(result.status.dataset.statusTone, "success");
});

test("ticket scan shows a generic failure without echoing the secret", async () => {
  const result = boot({ response: { ok: false, status: 400 } });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(result.status.textContent, "票据验证失败，请重新扫描现场二维码。");
  assert.equal(result.status.textContent.includes("ticket-secret"), false);
  assert.equal(result.status.dataset.statusTone, "error");
  assert.equal(result.status.classList.values.has("text-red-800"), true);
});

test("ticket scan does not make a request without a fragment", async () => {
  const result = boot({ hash: "" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(result.requests, []);
  assert.equal(result.status.textContent, "请扫描现场二维码，或输入票据码。");
  assert.equal(result.status.dataset.statusTone, "info");
});

test("ticket scan accepts a manual code through the same body-only endpoint", async () => {
  const result = boot({ hash: "" });
  result.manualInput.value = "manual-ticket-secret";
  const event = result.manualForm.dispatch("submit");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(event.prevented, true);
  assert.equal(result.requests[0].url, "/tickets/redeem/");
  assert.deepEqual(JSON.parse(result.requests[0].options.body), { secret: "manual-ticket-secret" });
  assert.equal(result.manualInput.value, "");
});

test("a dropped request keeps the credential for a retry", async () => {
  // The fragment is scrubbed before the request because it is a bearer secret, so a failed
  // request used to leave the viewer with nothing to retry — they had to walk back to the
  // poster. The value now stays in memory behind the retry button.
  const result = boot({ offline: true });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(result.status.textContent, "网络暂时不可用，请重试。");
  assert.equal(result.retryButton.hidden, false);
  // Scrubbed from the URL all the same.
  assert.deepEqual(result.historyCalls[0], [null, "", "/tickets/scan/"]);

  result.retryButton.click();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(result.requests.length, 2);
  assert.deepEqual(JSON.parse(result.requests[1].options.body), { secret: "ticket-secret" });
  assert.equal(result.retryButton.hidden, true);
  assert.equal(result.status.textContent, "票据已识别。完成现场检票后获得投票资格。");
});

test("a rejected credential offers no retry", async () => {
  // The server answered; re-sending the same code will not change its mind.
  const result = boot({ response: { ok: false, status: 400 } });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(result.retryButton.hidden, true);
});
