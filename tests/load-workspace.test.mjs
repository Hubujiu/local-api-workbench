import assert from "node:assert/strict";
import test from "node:test";
import { loadWorkspace } from "../public/load-workspace.js";

test("idle setup exposes the real preserved inputs, safety limits and no fabricated result", () => {
  const html = loadWorkspace({
    mode: "duration",
    durationSeconds: "60",
    count: 1,
    concurrency: 2,
    dataCSV: "key\n<x>",
  });
  for (const id of [
    "load-mode",
    "load-count",
    "load-duration",
    "load-concurrency",
    "load-data",
    "load-data-file",
    "load-run",
  ])
    assert.equal(html.split(`id="${id}"`).length, 2);
  assert.match(
    html,
    /id="load-duration" type="number" min="1" max="60" value="60"/,
  );
  assert.match(
    html,
    /id="load-count" type="number" value="1" min="1" max="100"/,
  );
  assert.match(html, /脚本子请求另计/);
  assert.match(html, /每次执行的变量独立，不回写项目/);
  assert.match(html, /暂无压测结果/);
  assert.match(html, /&lt;x&gt;/);
  assert.doesNotMatch(html, /<x>|grid-stats|公共压测数据|开启日志/);
});

test("actual result status and payload stay available without artificial idle or active evidence", () => {
  const html = loadWorkspace(
    {},
    {
      count: 2,
      passed: 1,
      stopReason: "count-limit",
      elapsed: 500,
      mainRequests: 2,
      scriptRequests: 1,
      timingSamples: 0,
      results: [{ error: "<fixture>" }],
    },
  );
  assert.match(html, /达到请求上限/);
  assert.match(html, /脚本子请求<strong>1<\/strong>/);
  assert.match(html, /&lt;fixture&gt;/);
  assert.doesNotMatch(html, /暂无压测结果|<fixture>/);
});
