import assert from "node:assert/strict";
import test from "node:test";
import {
  requestParameterTabs,
  revealParameterTab,
} from "../public/http-request-parameter-tabs.js";

test("request strip keeps all live actions and prioritizes the eight native tabs", () => {
  const html = requestParameterTabs({ bodyType: "none", headers: [] }, "query");
  assert.deepEqual(
    [...html.matchAll(/data-param="([^"]+)"/g)].map((match) => match[1]),
    [
      "headers",
      "query",
      "path",
      "body",
      "auth",
      "cookies",
      "before",
      "after",
      "examples",
      "assertions",
      "extract",
    ],
  );
  assert.match(html, /aria-pressed="false">Header<\/button>/);
  assert.match(html, /class="active" aria-pressed="true">Query<\/button>/);
  assert.match(html, /aria-pressed="false">Body<\/button>/);
  assert.match(html, />预执行操作<\/button>/);
  assert.match(html, />后执行操作<\/button>/);
  assert.equal(html.match(/aria-pressed="true"/g).length, 1);
});

test("meaningful request data keeps its count indicators", () => {
  const html = requestParameterTabs(
    {
      bodyType: "json",
      headers: [{ key: "Accept", value: "application/json" }],
      query: [
        { key: "id", value: "1" },
        { key: "page", value: "2" },
      ],
      examples: [{}],
    },
    "headers",
  );
  assert.match(html, />Header \(1\)<\/button>/);
  assert.match(html, />Query \(2\)<\/button>/);
  assert.match(html, />Body \(1\)<\/button>/);
  assert.match(html, />响应示例 \(1\)<\/button>/);
});

test("nearest-edge reveal scrolls only the parameter strip", () => {
  const strip = {
    scrollLeft: 40,
    getBoundingClientRect: () => ({ left: 100, right: 250 }),
  };
  revealParameterTab(strip, {
    getBoundingClientRect: () => ({ left: 85, right: 140 }),
  });
  assert.equal(strip.scrollLeft, 25);
  revealParameterTab(strip, {
    getBoundingClientRect: () => ({ left: 210, right: 280 }),
  });
  assert.equal(strip.scrollLeft, 55);
  revealParameterTab(strip, {
    getBoundingClientRect: () => ({ left: 180, right: 220 }),
  });
  assert.equal(strip.scrollLeft, 55);
});
