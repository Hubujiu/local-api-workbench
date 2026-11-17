import test from "node:test";
import assert from "node:assert/strict";
import {
  capturePlanHistoryFocus,
  restorePlanHistoryFocus,
} from "../public/plan-history-focus.js";
function fixture(id = 'id with "quotes"') {
  const focused = [],
    summary = { focus: (options) => focused.push(["summary", options]) },
    exp = { focus: (options) => focused.push(["export", options]) };
  const record = {
    dataset: { planRunId: id },
    open: false,
    querySelector: (q) => (q === "[data-export-run]" ? exp : summary),
  };
  const target = {
    isConnected: true,
    contains: (el) => [record, summary, exp].includes(el),
    querySelectorAll: () => [record],
  };
  const button = {
    isConnected: true,
    focus: (options) => focused.push(["button", options]),
  };
  for (const el of [summary, exp]) {
    el.closest = () => record;
    el.matches = () => el === exp;
  }
  return { focused, summary, exp, record, target, button };
}
for (const kind of ["summary", "export"])
  test(`restores ${kind} by literal stable ID`, () => {
    const f = fixture(),
      token = capturePlanHistoryFocus(
        f.target,
        kind === "export" ? f.exp : f.summary,
      );
    restorePlanHistoryFocus(f.target, f.button, token);
    assert.deepEqual(f.focused, [[kind, { preventScroll: true }]]);
    assert.equal(f.record.open, kind === "export");
  });
test("outside focus and absent focus are not stolen", () => {
  const f = fixture();
  for (const active of [null, {}]) {
    const token = capturePlanHistoryFocus(f.target, active);
    assert.equal(token, null);
    restorePlanHistoryFocus(f.target, f.button, token);
  }
  assert.deepEqual(f.focused, []);
});
test("removed record and unrecognized nested control fall back", () => {
  const f = fixture();
  restorePlanHistoryFocus(f.target, f.button, {
    kind: "export",
    id: "removed",
  });
  restorePlanHistoryFocus(f.target, f.button, { kind: "fallback" });
  assert.deepEqual(f.focused, [
    ["button", { preventScroll: true }],
    ["button", { preventScroll: true }],
  ]);
});
test("detached owner cannot steal focus", () => {
  const f = fixture();
  f.target.isConnected = false;
  restorePlanHistoryFocus(f.target, f.button, {
    kind: "export",
    id: f.record.dataset.planRunId,
  });
  assert.deepEqual(f.focused, []);
});

test("nested control restores surviving record summary", () => {
  const f = fixture(),
    nested = { closest: () => f.record, matches: () => false };
  const contains = f.target.contains;
  f.target.contains = (el) => el === nested || contains(el);
  const token = capturePlanHistoryFocus(f.target, nested);
  restorePlanHistoryFocus(f.target, f.button, token);
  assert.deepEqual(f.focused, [["summary", { preventScroll: true }]]);
});
test("focus helper is served by the real application static route", async (t) => {
  const { createApp } = await import("../src/server.mjs");
  const { mkdtemp, rm, readFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const root = await mkdtemp(path.join(tmpdir(), "focus-static-"));
  const app = await createApp({ root, port: 0 });
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const response = await fetch(app.url + "/plan-history-focus.js");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /javascript/);
  assert.equal(
    await response.text(),
    await readFile(
      new URL("../public/plan-history-focus.js", import.meta.url),
      "utf8",
    ),
  );
});
