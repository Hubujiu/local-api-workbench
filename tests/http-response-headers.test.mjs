import assert from "node:assert/strict";
import test from "node:test";
import {
  httpResponseHeaderRows,
  httpResponseHeadersHTML,
} from "../public/http-response-headers.js";
import { httpResponseTabs } from "../public/http-response-tabs.js";

test("completed response projects only transport strings without losing arrays, commas, or leading zeros", () => {
  const cookies = Object.freeze(["first=0007; Path=/", "second=two; Path=/"]);
  const headers = Object.freeze({
    "x-literal": "0007, a,, b",
    "x-empty": "",
    "set-cookie": cookies,
  });
  const response = Object.freeze({
    status: 403,
    headers,
    scriptResponse: { status: 200, headers: { "x-pretend": "not network" } },
  });
  assert.deepEqual(httpResponseHeaderRows(response), [
    ["x-literal", "0007, a,, b"],
    ["x-empty", ""],
    ["set-cookie", cookies[0]],
    ["set-cookie", cookies[1]],
  ]);
  assert.deepEqual(httpResponseHeaderRows({ status: 204, headers: {} }), []);
  for (const incomplete of [
    null,
    { status: 0, headers },
    { error: "no response", headers },
    { status: 400, scriptResponse: { headers } },
    { status: "200", headers },
    { status: 200, headers: { malformed: [7] } },
  ])
    assert.equal(httpResponseHeaderRows(incomplete), null);
});

test("transport row markup is semantic and no count is invented for an unsent view", () => {
  const escaped = [];
  const html = httpResponseHeadersHTML(
    [["x-example", "<b>0007</b>"]],
    (text) => {
      escaped.push(text);
      return text.replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    },
  );
  assert.deepEqual(escaped, ["x-example", "<b>0007</b>"]);
  assert.match(
    html,
    /<th scope="col">参数名<\/th><th scope="col">参数值<\/th>/,
  );
  assert.match(
    html,
    /<th scope="row">x-example<\/th><td>&lt;b&gt;0007&lt;\/b&gt;<\/td>/,
  );
  assert.match(
    httpResponseHeadersHTML([], () => ""),
    /暂无响应头/,
  );
  assert.doesNotMatch(
    httpResponseTabs("headers", false),
    /http-response-header-count/,
  );
  assert.match(
    httpResponseTabs("headers", false, 0),
    /http-response-header-count">\(0\)/,
  );
  assert.match(
    httpResponseTabs("headers", true, 4),
    /http-response-header-count">\(4\)/,
  );
});
