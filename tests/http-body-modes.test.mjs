import assert from "node:assert/strict";
import test from "node:test";
import {
  httpBodyFamilies,
  httpBodyFamily,
  httpBodyModesHTML,
} from "../public/http-body-modes.js";

test("split and stacked Body controls share the six canonical families; JSON is Raw", () => {
  const html = httpBodyModesHTML("json", { compact: true });
  assert.equal(httpBodyFamily("json"), "raw");
  assert.equal(httpBodyFamily("raw"), "raw");
  assert.equal(
    (html.match(/name="body-type"/g) || []).length,
    httpBodyFamilies.length,
  );
  assert.match(html, /name="body-type" value="raw" checked/);
  assert.match(html, /<option value="raw" selected>raw/);
  assert.match(html, /<option value="json" selected>JSON/);
  assert.equal((html.match(/id="raw-format"/g) || []).length, 1);
  assert.doesNotMatch(httpBodyModesHTML("none"), /http-split-body-family/);
});

test("unknown Body formats are never labeled none or injected into compact HTML", () => {
  const html = httpBodyModesHTML("<unknown>", { compact: true });
  assert.match(html, /id="http-split-body-family"[^>]* disabled/);
  assert.match(html, /当前格式不受支持/);
  assert.doesNotMatch(html, /value="none" (checked|selected)|<unknown>/);
  assert.doesNotMatch(html, /id="raw-format"/);
});
