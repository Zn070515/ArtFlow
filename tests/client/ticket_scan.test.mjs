import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../../static/dist/ticket_scan.js", import.meta.url), "utf8");

function boot({
  hash = "#ticket-secret",
  response = { ok: true, status: 200 },
  ticketState = "issued",
} = {}) {
  const status = { textContent: "" };
  const root = {};
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
      return { ...response, json: async () => ({ ticket_state: ticketState }) };
    },
    setTimeout,
    console,
  };
  vm.runInNewContext(source, context);
  return { status, requests, historyCalls };
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
});

test("ticket scan explains when a checked-in ticket is eligible", async () => {
  const result = boot({ ticketState: "checked_in" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(
    result.status.textContent,
    "已完成现场检票。你已具备票券投票资格，具体以当前投票场次状态为准。",
  );
});

test("ticket scan shows a generic failure without echoing the secret", async () => {
  const result = boot({ response: { ok: false, status: 400 } });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(result.status.textContent, "票据验证失败，请重新扫描现场二维码。");
  assert.equal(result.status.textContent.includes("ticket-secret"), false);
});

test("ticket scan does not make a request without a fragment", async () => {
  const result = boot({ hash: "" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(result.requests, []);
  assert.equal(result.status.textContent, "请扫描现场二维码。");
});
