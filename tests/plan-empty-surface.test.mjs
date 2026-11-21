import test from "node:test";
import assert from "node:assert/strict";
import { renderPlans, renderRuns } from "../public/plan-view.js";
const project = { plans: [], runs: [], environments: [] };
test("empty plan surface describes actual permissions and keeps creation reachable", () => {
  const html = renderPlans({ project });
  assert.match(html, /<h1>AI执行计划<\/h1>/);
  assert.match(html, /已授权的 MCP/);
  assert.match(html, /id="new-plan"/);
  assert.match(html, /暂无执行计划/);
  assert.match(html, /请选择或新建一个执行计划/);
  assert.match(html, /data-plan-tab="plans" aria-pressed="true"/);
  assert.match(html, /id="mcp-plan-status"/);
  assert.doesNotMatch(html, /id="run-plan"/);
});
test("record tab remains read-only refresh with truthful selected state", () => {
  const html = renderPlans({ project, tab: "runs" });
  assert.match(html, /data-plan-tab="runs" aria-pressed="true"/);
  assert.match(html, /id="refresh-plan-history"/);
  assert.match(html, /不运行计划或保存草稿/);
  assert.match(html, /id="plan-history-refresh-status" role="status"/);
  assert.ok(
    html.indexOf('id="refresh-plan-history"') <
      html.indexOf("plan-history-layout"),
  );
  assert.equal(
    renderRuns([]),
    '<p class="plan-history-empty">暂无执行记录</p>',
  );
  assert.doesNotMatch(html, /请选择或新建一个执行计划|最近 50 条/);
});
test("populated and busy plans retain editor, stop, escaping and selection", () => {
  const p = {
    ...project,
    plans: [{ id: "test", name: "<unsafe>", steps: [] }],
  };
  const html = renderPlans({ project: p, planId: "test", busy: true });
  assert.match(html, /&lt;unsafe&gt;/);
  assert.match(html, /data-plan="test" class="active"/);
  assert.match(html, /id="run-plan" class="primary" disabled/);
  assert.match(html, /id="cancel"/);
  assert.match(html, /id="save-plan-details"/);
  assert.doesNotMatch(html, /暂无执行计划|请选择或新建一个执行计划/);
});

test("refresh rendering can swap an empty canvas for real records and export", () => {
  const run = {
    id: "one",
    status: "passed",
    planName: "<local plan>",
    results: [],
  };
  const html = renderRuns([run], run);
  assert.match(html, /data-plan-run-id="one" open/);
  assert.match(html, /&lt;local plan&gt;/);
  assert.match(html, /data-export-run="one"/);
  assert.doesNotMatch(html, /plan-history-empty/);
});
