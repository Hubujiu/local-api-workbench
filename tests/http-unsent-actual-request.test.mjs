import test from "node:test";
import assert from "node:assert/strict";
import { unsentActualRequestHTML } from "../public/http-unsent-actual-request.js";

test("unsent Actual Request contains four linked sections and no wire values", () => {
  const html = unsentActualRequestHTML("GET", "query");
  assert.match(html, /实际请求（未发送）/);
  assert.match(html, /编辑器所选方法，尚未发送">GET<\/span><span>未发送/);
  for (const [key, label] of [
    ["header", "Header"],
    ["query", "Query"],
    ["path", "Path"],
    ["body", "Body"],
  ]) {
    const selected = key === "query";
    assert.match(
      html,
      new RegExp(
        `role="tab" id="actual-unsent-tab-${key}"[^>]*aria-controls="actual-unsent-panel-${key}" aria-selected="${selected}" tabindex="${selected ? 0 : -1}">${label}</button>`,
      ),
    );
    assert.match(
      html,
      new RegExp(
        `id="actual-unsent-panel-${key}" role="tabpanel" aria-labelledby="actual-unsent-tab-${key}" tabindex="0"${selected ? "" : " hidden"}>`,
      ),
    );
  }
  assert.match(html, /类型:/);
  for (const text of [
    "未定义请求头",
    "未定义 URL 参数",
    "未定义路径参数",
    "未定义请求体",
  ])
    assert(html.includes(text));
  assert.doesNotMatch(html, /https?:\/\/|data-response=|type="submit"/);
});

test("unknown method and unknown section do not emerge from opaque input", () => {
  const html = unsentActualRequestHTML(
    "<script>alert(1)</script>",
    "not-a-tab",
  );
  assert.doesNotMatch(html, /<script>|class="method/);
  assert.match(
    html,
    /data-actual-unsent-tab="header"[^>]*aria-selected="true"/,
  );
});
