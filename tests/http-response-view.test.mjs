import assert from "node:assert/strict";
import test from "node:test";
import {
  responseBodyModel,
  responseBodyView,
} from "../public/http-response-view.js";

test("response display formats without rewriting raw network evidence", () => {
  const body = '{"id":101,"username":"visual-fixture","status":"created"}\n';
  const model = responseBodyModel(body);
  assert.equal(model.raw, body);
  assert.equal(model.pretty, JSON.stringify(JSON.parse(body), null, 4));
  assert.equal(model.json, true);
  assert.match(responseBodyView(body), /aria-label="响应正文"/);
  assert.equal(responseBodyModel(body).raw, body);
});

test("untrusted response text is escaped in JSON and plain formats", () => {
  for (const body of [
    "<img src=x onerror=alert(1)>",
    '{"x":"<script>alert(1)</script>"}',
  ]) {
    const html = responseBodyView(body);
    assert(!html.includes("<img"));
    assert(!html.includes("<script>"));
    assert(html.includes("&lt;"));
    assert.equal(responseBodyModel(body).raw, body);
  }
  assert.equal(responseBodyModel("not json").json, false);
  assert.equal(responseBodyModel("").pretty, "");
});

test("raw toggle preserves CRLF and focusable controls without rewriting evidence", async () => {
  const { bindResponseBody } = await import("../public/http-response-view.js");
  const body = '{\r\n  "text": "<img src=x onerror=alert(1)>"\r\n}\r\n';
  const text = { textContent: "" };
  const code = { outerHTML: "" };
  const buttons = ["pretty", "raw"].map((format) => ({
    dataset: { responseFormat: format },
    setAttribute(key, value) {
      this[key] = value;
    },
    closest() {
      return view;
    },
  }));
  const view = {
    querySelector(selector) {
      return selector === "#http-response-text" ? text : code;
    },
    querySelectorAll() {
      return buttons;
    },
  };
  bindResponseBody(view, body);
  buttons[1].onclick();
  assert.equal(text.textContent, body);
  assert.equal(buttons[1]["aria-pressed"], "true");
  assert(!code.outerHTML.includes("<img"));
  buttons[0].onclick();
  assert.equal(buttons[0]["aria-pressed"], "true");
  assert.equal(responseBodyModel(body).raw, body);
});
