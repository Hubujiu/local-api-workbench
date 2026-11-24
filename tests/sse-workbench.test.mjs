import assert from "node:assert/strict";
import test from "node:test";
import { selectedSSEWorkbench } from "../public/sse-workbench.js";

const item = {
  type: "sse",
  name: "<Sample>",
  url: "http://127.0.0.1:1/?q=<x>",
  method: "POST",
  body: "saved-not-manual",
};
test("only a saved SSE surface is framed and unsupported manual request options are not invented", () => {
  const context = {
    busy: false,
    session: { canConnect: true },
    status: "未连接",
  };
  assert.equal(selectedSSEWorkbench(undefined, context), "");
  assert.equal(selectedSSEWorkbench({ type: "websocket" }, context), "");
  assert.equal(selectedSSEWorkbench({ type: "tcp" }, context), "");
  const html = selectedSSEWorkbench(item, context);
  assert.match(html, /&lt;Sample&gt;/);
  assert.match(html, /\?q=&lt;x&gt;/);
  assert.doesNotMatch(html, /POST|saved-not-manual|auth|role="tab"/);
  assert.match(html, /id="session-connect"[^>]*>建立交互会话/);
  for (const id of [
    "protocol-run",
    "cancel",
    "save-protocol",
    "delete-protocol",
    "protocol-result",
    "session-stop",
    "session-refresh",
    "session-export",
    "session-events",
  ])
    assert.equal(html.match(new RegExp('id="' + id + '"', "g"))?.length, 1);
});
test("unknown global state and actual evidence are passed through without showing an enabled connect", () => {
  const html = selectedSSEWorkbench(item, {
    busy: true,
    session: { canConnect: false, canStop: true, canSend: false },
    status: "连接结果待核对 · <pending>",
    events: "event received <record>",
  });
  assert.match(html, /id="protocol-run"[^>]*disabled/);
  assert.match(html, /id="session-connect"[^>]*disabled/);
  assert.match(html, /id="session-stop"(?![^>]*disabled)/);
  assert.match(html, /id="session-send"[^>]*disabled/);
  assert.match(html, /连接结果待核对 · &lt;pending&gt;/);
  assert.match(html, /event received &lt;record&gt;/);
});
