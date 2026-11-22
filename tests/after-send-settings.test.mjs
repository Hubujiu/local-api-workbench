import assert from "node:assert/strict";
import test from "node:test";
import {
  afterSendResponseKey,
  createManualResponseView,
  readAfterSendResponse,
  saveAfterSendResponse,
} from "../public/after-send-settings.js";

test("post-send response preference is local, opt-in, independent and resettable", () => {
  const saved = new Map([["theme", "dark"]]);
  const storage = {
    getItem: saved.get.bind(saved),
    setItem: saved.set.bind(saved),
    removeItem: saved.delete.bind(saved),
  };
  assert.equal(readAfterSendResponse(storage), false);
  saved.set(afterSendResponseKey, "invalid");
  assert.equal(readAfterSendResponse(storage), false);
  saveAfterSendResponse(storage, true);
  assert.equal(readAfterSendResponse(storage), true);
  saveAfterSendResponse(storage, false);
  assert.deepEqual([...saved.keys()], ["theme"]);
});

test("an actual fresh HTTP response reveals only the same Debug view without user tab interaction", () => {
  const view = createManualResponseView();
  const source = { id: "p" };
  view.observe(source, "request");
  const capture = () => view.capture(true, source, "request");
  assert.equal(view.capture(false, source, "request"), null);
  assert.equal(view.capture(true, { id: source.id }, "request"), null);
  assert.equal(view.capture(true, source, "other"), null);
  const original = capture();
  assert.equal(view.shouldReveal(original, true, { status: 404 }), true);
  assert.equal(view.shouldReveal(original, false, { status: 200 }), false);
  for (const value of [
    undefined,
    {},
    { status: 0 },
    { status: "200" },
    { status: 999 },
  ])
    assert.equal(view.shouldReveal(original, true, value), false);
  view.selected();
  assert.equal(view.shouldReveal(original, true, { status: 200 }), false);
  const beforeLeave = capture();
  view.observe(null, "request");
  view.observe(source, "request");
  assert.equal(view.shouldReveal(beforeLeave, true, { status: 200 }), false);
  const beforeRequestChange = capture();
  view.observe(source, "other");
  view.observe(source, "request");
  assert.equal(
    view.shouldReveal(beforeRequestChange, true, { status: 200 }),
    false,
  );
  const beforeOwnerChange = capture();
  view.observe({ id: source.id }, "request");
  assert.equal(
    view.shouldReveal(beforeOwnerChange, true, { status: 200 }),
    false,
  );
});
