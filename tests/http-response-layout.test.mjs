import assert from "node:assert/strict";
import test from "node:test";
import {
  effectiveResponseLayout,
  httpResponseLayoutHTML,
} from "../public/http-response-layout.js";

test("layout preference resolves to stacked on narrow surfaces without rewriting split intent", () => {
  assert.equal(effectiveResponseLayout("split", true), "split");
  assert.equal(effectiveResponseLayout("split", false), "stacked");
  assert.equal(effectiveResponseLayout("stacked", true), "stacked");
  assert.equal(effectiveResponseLayout("invalid", true), "stacked");
});

test("HTTP response layout carries two actual radio menu options and can reserve a row", () => {
  const html = httpResponseLayoutHTML(false);
  assert.doesNotMatch(html, /http-response-layout-parked/);
  assert.match(html, /popover="auto" role="menu"/);
  assert.match(html, /aria-controls="http-response-layout-menu"/);
  assert.match(html, /data-http-layout="stacked"[^]*上下分屏/);
  assert.match(html, /data-http-layout="split"[^]*左右分屏/);
  assert.equal((html.match(/role="menuitemradio"/g) || []).length, 2);
  assert.match(httpResponseLayoutHTML(true), /http-response-layout-parked/);
});
