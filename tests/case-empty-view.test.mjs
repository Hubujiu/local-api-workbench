import test from "node:test";
import assert from "node:assert/strict";
import { emptyCasePanel } from "../public/case-empty-view.js";

test("empty case surface exposes existing actions without inventing data pools or reports", () => {
  const html = emptyCasePanel({}, "api");
  for (const id of ["new-interface-case", "new-case-folder", "create-case"])
    assert.equal(html.split(`id="${id}"`).length, 2);
  assert.match(html, /独立请求快照/);
  assert.match(html, /不改变请求快照/);
  assert.doesNotMatch(html, /测试报告|常规数据池|全选|运行所选/);
});

test("existing cases or empty groups keep their original populated workflow", () => {
  assert.equal(
    emptyCasePanel({ cases: [{ sourceRequestId: "api" }] }, "api"),
    null,
  );
  assert.equal(
    emptyCasePanel({ caseFolders: [{ sourceRequestId: "api" }] }, "api"),
    null,
  );
  assert.ok(
    emptyCasePanel(
      {
        cases: [{ sourceRequestId: "other" }],
        caseFolders: [{ sourceRequestId: "other" }],
      },
      "api",
    ),
  );
});

test("busy creation remains disabled and untrusted project names are not interpolated", () => {
  const html = emptyCasePanel({ name: '<img onerror="bad()">' }, "api", true);
  assert.equal((html.match(/ disabled/g) || []).length, 2);
  assert.doesNotMatch(html, /onerror/);
});
