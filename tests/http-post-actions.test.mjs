import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
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

const source = await readFile(
  new URL("../public/app.js", import.meta.url),
  "utf8",
);
const bindStart = source.indexOf(
  '  const postWorkspace = $(".http-post-actions");',
);
const bindEnd = source.indexOf("  if (preWorkspace) {", bindStart);
const releaseStart = source.indexOf("  releaseHTTPPostActions?.();");
assert.ok(bindStart > 0 && bindEnd > bindStart && releaseStart > 0);
const rendered = new Function(
  "env",
  `with (env) { ${source.slice(bindStart, bindEnd)} }`,
);
const release = new Function(
  "env",
  `with (env) { ${source.slice(releaseStart, source.indexOf("  releaseHTTPPreActions?.();", releaseStart))} }`,
);

test("the actual render-boundary binding remembers native disclosure state even before the toggle task", () => {
  for (const switchOwner of [false, true]) {
    const target = { id: "overlap" };
    const disclosure = { open: true };
    const panel = { isConnected: true, querySelector: () => disclosure };
    const ownKey = '["a","overlap"]';
    const otherKey = '["b","overlap"]';
    let queued,
      released = 0;
    const env = {
      $: () => panel,
      project: { id: "a" },
      request: () => target,
      page: "apis",
      mode: "debug",
      param: "after",
      httpPostAdvancedKey: (r) => JSON.stringify([env.project.id, r.id]),
      httpPostAdvanced: new Set([ownKey, otherKey]),
      releaseHTTPPostActions: undefined,
      on: (_, event, callback) => {
        assert.equal(event, "toggle");
        queued = () => callback(null, disclosure);
      },
      bindHTTPPostActions: () => () => released++,
    };
    rendered(env);
    // Changing HTMLDetailsElement.open is synchronous, its toggle event is not.
    disclosure.open = false;
    if (switchOwner) env.project = { id: "b" };
    else env.param = "assertions";
    release(env);
    panel.isConnected = false;
    queued();
    assert.equal(env.httpPostAdvanced.has(ownKey), false);
    assert.equal(env.httpPostAdvanced.has(otherKey), true);
    assert.equal(released, 1);
  }
});
