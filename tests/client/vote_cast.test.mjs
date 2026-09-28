import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../../static/dist/vote_cast.js", import.meta.url), "utf8");

class FakeInput {
  constructor() {
    this.checked = false;
    this.listeners = new Map();
  }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  dispatch(type) { this.listeners.get(type)?.(); }
}

function boot(confirmResult = true) {
  const first = new FakeInput();
  const second = new FakeInput();
  const counter = { textContent: "" };
  const submit = { disabled: false };
  const form = {
    dataset: { confirmMessage: "投票提交后不可修改，确定提交吗？" },
    listeners: new Map(),
    addEventListener(type, listener) { this.listeners.set(type, listener); },
    dispatch(type) {
      const event = { prevented: false, preventDefault() { this.prevented = true; } };
      this.listeners.get(type)?.(event);
      return event;
    },
  };
  const root = {
    dataset: { maxSelections: "2" },
    querySelector(selector) {
      if (selector === "[data-vote-form]") return form;
      if (selector === "[data-vote-submit]") return submit;
      if (selector === "[data-selection-count]") return counter;
      return null;
    },
    querySelectorAll() { return [first, second]; },
  };
  const context = {
    document: { querySelector: () => root },
    window: { confirm: () => confirmResult },
  };
  vm.runInNewContext(source, context);
  return { first, second, counter, submit, form };
}

test("vote cast reports selection count and disables empty submit", () => {
  const runtime = boot();

  assert.equal(runtime.counter.textContent, "已选择 0 / 2");
  assert.equal(runtime.submit.disabled, true);
  runtime.first.checked = true;
  runtime.first.dispatch("change");
  assert.equal(runtime.counter.textContent, "已选择 1 / 2");
  assert.equal(runtime.submit.disabled, false);
});

test("vote cast asks for confirmation before an irreversible submit", () => {
  const runtime = boot(false);
  runtime.first.checked = true;
  runtime.first.dispatch("change");

  const event = runtime.form.dispatch("submit");
  assert.equal(event.prevented, true);
});
