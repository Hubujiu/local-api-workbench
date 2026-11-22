import assert from "node:assert/strict";
import test from "node:test";
import { httpPostActionsHTML } from "../public/http-post-actions.js";

test("post operation workspace advertises only real script and dedicated rule editors", () => {
  const html = httpPostActionsHTML({ configured: "", advanced: "" });
  assert.match(
    html,
    /data-post-action="script" aria-haspopup="dialog">自定义脚本/,
  );
  assert.match(html, /data-post-action="assertions">打开断言/);
  assert.match(html, /data-post-action="extract">打开提取变量/);
  assert.doesNotMatch(html, /data-post-action="(?:database|wait)"/);
  assert.match(html, /数据库只读操作需要单独授权/);
  assert.match(html, /id="http-post-advanced">/);
  assert.doesNotMatch(html, /已配置后置 JavaScript/);
});

test("authored operations and existing advanced editor remain real markup", () => {
  const html = httpPostActionsHTML({
    configured: "<p>one</p>",
    advanced: "<select></select>",
    open: true,
    hasScript: true,
  });
  assert(html.indexOf("<p>one</p>") < html.indexOf('id="http-post-add"'));
  assert.match(html, /已配置后置 JavaScript/);
  assert.match(html, /id="http-post-advanced" open>.*<select><\/select>/s);
});
