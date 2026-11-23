import assert from "node:assert/strict";
import test from "node:test";
import { httpPreActionsHTML } from "../public/http-pre-actions.js";

test("pre stage opens only genuine ordinary script and approved database editors", () => {
  const html = httpPreActionsHTML({ configured: "", advanced: "", script: "" });
  assert.match(html, /data-pre-action="script">自定义脚本/);
  assert.match(
    html,
    /data-pre-action="database" aria-haspopup="dialog">数据库/,
  );
  assert.doesNotMatch(html, /等待|http-pre-script-card|已配置前置/);
  assert.match(html, /数据库只读操作需要单独授权/);
  assert.match(html, /id="http-pre-advanced">/);
});

test("existing declarative actions precede the single editable stage script", () => {
  const html = httpPreActionsHTML({
    configured: "<p>declared first</p>",
    advanced: "<p>advanced here</p>",
    script: '<textarea id="script-code">actual script</textarea>',
    scriptOpen: true,
    advancedOpen: true,
    hasScript: true,
  });
  assert(html.indexOf("declared first") < html.indexOf("http-pre-script-card"));
  assert.match(html, /id="script-code">actual script/);
  assert.match(html, /id="http-pre-advanced" open>.*advanced here/);
  assert.match(
    httpPreActionsHTML({ configured: "", advanced: "", hasScript: true }),
    /已配置前置 JavaScript/,
  );
});
