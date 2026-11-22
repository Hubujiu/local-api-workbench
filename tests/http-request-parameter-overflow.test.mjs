import assert from "node:assert/strict";
import test from "node:test";
import {
  clippedRequestTab,
  requestParameterOverflowHTML,
} from "../public/http-request-parameter-overflow.js";

test("request overflow counts real left/right clipped and offscreen tabs", () => {
  const view = { left: 371, right: 803 };
  assert.equal(clippedRequestTab({ left: 371, right: 432 }, view), false);
  assert.equal(clippedRequestTab({ left: 370, right: 803.5 }, view), false);
  assert.equal(clippedRequestTab({ left: 759, right: 823 }, view), true);
  assert.equal(clippedRequestTab({ left: 830, right: 970 }, view), true);
  assert.equal(clippedRequestTab({ left: 335, right: 401 }, view), true);
  assert.equal(clippedRequestTab({ left: 291, right: 350 }, view), true);
});

test("overflow disclosure is initially hidden and creates no synthetic tab actions", () => {
  const html = requestParameterOverflowHTML();
  assert.match(html, /class="http-request-overflow" hidden/);
  assert.match(html, /aria-controls="http-request-overflow-menu"/);
  assert.match(html, /popover="auto" role="menu"/);
  assert.doesNotMatch(html, /data-param=|data-overflow-param=/);
});
