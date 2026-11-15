import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { observeRefreshCompletion } from "./helpers/plan-history-refresh-held-ui.mjs";
function fixture() {
  class Target {
    addEventListener(type, listener, options) {
      this.registration = { type, listener, options };
    }
  }
  class Element extends Target {
    constructor(id) {
      super();
      this.id = id;
    }
  }
  const context = vm.createContext({
    window: {},
    EventTarget: Target,
    HTMLElement: Element,
  });
  vm.runInContext(`(${observeRefreshCompletion.toString()})()`, context);
  return { context, Element };
}
test("fixture observer preserves actual listener this/event/result and waits for completion", async () => {
  const { context, Element } = fixture(),
    element = new Element("refresh-plan-history");
  let release,
    called = 0;
  const pending = new Promise((resolve) => (release = resolve)),
    event = { type: "click" };
  const options = { once: true };
  element.addEventListener(
    "click",
    async function (received) {
      assert.equal(this, element);
      assert.equal(received, event);
      called++;
      await pending;
      return "actual handler done";
    },
    options,
  );
  assert.equal(element.registration.options, options);
  const result = element.registration.listener.call(element, event);
  assert.equal(called, 1);
  assert.equal(context.window.__planRefreshCompleted, 0);
  release();
  assert.equal(await result, "actual handler done");
  assert.equal(context.window.__planRefreshCompleted, 1);
});
test("fixture observer does not swallow listener rejection", async () => {
  const { context, Element } = fixture(),
    element = new Element("refresh-plan-history"),
    failure = Error("original");
  element.addEventListener("click", async () => {
    throw failure;
  });
  await assert.rejects(
    element.registration.listener(),
    (error) => error === failure,
  );
  assert.equal(context.window.__planRefreshCompleted, 1);
});
test("fixture observer leaves unrelated or non-function listeners unchanged", () => {
  const { Element } = fixture();
  for (const [id, type, listener] of [
    ["other", "click", () => {}],
    ["refresh-plan-history", "change", () => {}],
    ["refresh-plan-history", "click", { handleEvent() {} }],
  ]) {
    const element = new Element(id);
    element.addEventListener(type, listener);
    assert.equal(element.registration.listener, listener);
  }
});
