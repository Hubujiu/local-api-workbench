import assert from "node:assert/strict";
import test from "node:test";
import {
  httpResponseTabs,
  readResponseTabsPosition,
  restoreResponseTabsPosition,
} from "../public/http-response-tabs.js";

test("HTTP responses keep native ordering and all Workbench evidence tabs", () => {
  const markup = httpResponseTabs("headers", true);
  assert.deepEqual(
    [...markup.matchAll(/data-response="([^"]+)"/g)].map((match) => match[1]),
    [
      "body",
      "headers",
      "cookies",
      "examples",
      "request",
      "logs",
      "visualization",
      "scriptResponse",
      "assertions",
      "extracted",
      "subrequests",
    ],
  );
  assert.match(
    markup,
    /data-response="headers" class="active" aria-pressed="true"/,
  );
  assert.equal(markup.match(/aria-pressed="true"/g).length, 1);
  assert.doesNotMatch(
    httpResponseTabs("body", false),
    /data-response="subrequests"/,
  );
});

test("response strip restores focus and scrolls only the clipped edge", () => {
  const events = [];
  const button = {
    dataset: { response: "extracted" },
    focus: (options) => events.push(options),
    getBoundingClientRect: () => ({ left: 190, right: 240 }),
  };
  const strip = {
    scrollLeft: 41,
    contains: (active) => active === button,
    querySelector: () => button,
    querySelectorAll: () => [button],
    getBoundingClientRect: () => ({ left: 100, right: 220 }),
  };
  const previous = readResponseTabsPosition(strip, button);
  assert.deepEqual(previous, {
    scrollLeft: 41,
    focused: "extracted",
    selected: "extracted",
  });
  restoreResponseTabsPosition(strip, previous);
  assert.deepEqual(events, [{ preventScroll: true }]);
  assert.equal(strip.scrollLeft, 61);
  assert.equal(readResponseTabsPosition(undefined, null).scrollLeft, 0);
});
