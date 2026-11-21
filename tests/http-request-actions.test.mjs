import test from "node:test";
import assert from "node:assert/strict";
import {
  httpRequestActions,
  requestCurlAction,
} from "../public/http-request-actions.js";

const actionIds = [
  "send",
  "send-menu-curl",
  "send-menu-plan",
  "save",
  "save-menu-copy",
  "save-menu-project",
];

test("debug split actions preserve distinct primary and disclosure controls", () => {
  const html = httpRequestActions({ debug: true, dirty: false });
  assert.match(
    html,
    /role="group" aria-label="发送请求"><button id="send"[^>]*>发 送<\/button><details.*?aria-label="发送更多操作"/,
  );
  assert.match(
    html,
    /role="group" aria-label="保存请求"><button id="save"[^>]*>保存<\/button><details.*?aria-label="保存更多操作"/,
  );
  for (const id of actionIds)
    assert.equal(html.split(`id="${id}"`).length, 2, id);
  assert.doesNotMatch(html, /id="curl"/);
  assert.match(requestCurlAction(true), /id="curl"[^>]*aria-label="生成 cURL"/);
  assert.equal(requestCurlAction(false), "");
});

test("busy/dirty state and legacy mode keep original action affordances", () => {
  const options = { busy: true, cancel: true, dirty: true };
  const debug = httpRequestActions({ ...options, debug: true });
  const legacy = httpRequestActions(options);
  for (const html of [debug, legacy]) {
    assert.match(html, /id="send"[^>]+disabled>请求中…/);
    assert.match(html, /id="save"[^>]+class="primary">保存/);
    assert.match(html, /id="cancel"[^>]*>取消/);
    for (const id of actionIds)
      assert.equal(html.split(`id="${id}"`).length, 2, id);
  }
  assert.doesNotMatch(legacy, /http-action-split/);
  assert.match(legacy, /id="curl"[^>]*aria-label="生成 cURL"/);
  assert.doesNotMatch(
    httpRequestActions({ debug: true, busy: true, cancel: false }),
    /id="cancel"/,
  );
});
