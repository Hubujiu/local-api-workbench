import test from "node:test";
import assert from "node:assert/strict";
import { importPostmanRawBody } from "../src/postman-raw-body.mjs";
for (const language of ["xml", "html", "javascript", "text"]) {
  test(`Postman raw ${language} retains delayed media identity without adding explicit headers`, () => {
    const source = {
      mode: "raw",
      raw: "opaque payload",
      options: { raw: { language } },
    };
    const actual = importPostmanRawBody(source);
    assert.equal(actual.body, "opaque payload");
    assert.equal(actual.bodyType, "raw");
    assert.deepEqual(actual.postmanRawBody, { version: 1, language });
    assert.equal(Object.hasOwn(actual, "headers"), false);
  });
}
test("unmarked JSON projection preserves the existing bounded JSON contract", () => {
  assert.deepEqual(
    importPostmanRawBody({
      mode: "raw",
      raw: '{"a":1}',
      options: { raw: { language: "json" } },
    }),
    { bodyType: "json", body: '{"a":1}' },
  );
});

import {
  postmanRawBodyPolicy,
  applyPostmanRawMedia,
  assertPostmanRawProfiles,
  postmanRawExportDefinition,
} from "../src/postman-raw-body.mjs";
const request = (language = "xml", extra = {}) => ({
  method: "POST",
  bodyType: "raw",
  body: "<x/>",
  headers: [],
  postmanRawBody: { version: 1, language },
  ...extra,
});
for (const [language, type] of Object.entries({
  xml: "application/xml",
  html: "text/html",
  javascript: "application/javascript",
  text: "text/plain",
  default: "text/plain",
}))
  test(`late raw ${language} media default`, () => {
    const headers = {};
    applyPostmanRawMedia(request(language), headers);
    assert.equal(headers["content-type"], type);
  });
test("empty body skips default but whitespace does not", () => {
  const empty = {},
    space = {};
  applyPostmanRawMedia(request("xml", { body: "" }), empty);
  applyPostmanRawMedia(request("xml", { body: " " }), space);
  assert.deepEqual(empty, {});
  assert.equal(space["content-type"], "application/xml");
});
test("explicit and explicit-empty headers override, disabled permits default", () => {
  for (const value of ["application/custom", ""]) {
    const h = { "content-type": value };
    applyPostmanRawMedia(request(), h);
    assert.equal(h["content-type"], value);
  }
  const r = request("xml", {
    headers: [{ key: "CONTENT-TYPE", value: "old", enabled: false }],
  });
  const h = {};
  applyPostmanRawMedia(r, h);
  assert.equal(h["content-type"], "application/xml");
});
test("default language rejects any Content-Type ambiguity including disabled duplicate text", () => {
  for (const rows of [
    [{ key: "Content-Type", value: "application/json" }],
    [{ key: "CONTENT-TYPE", value: "text/plain", enabled: false }],
    [
      { key: "Content-Type", value: "text/plain", enabled: false },
      { key: "content-type", value: "text/plain", enabled: false },
    ],
  ])
    assert.throws(() =>
      applyPostmanRawMedia(request("default", { headers: rows }), {}),
    );
});
test("nonempty GET HEAD reject before media mutation; empty GET remains empty", () => {
  for (const method of ["GET", "HEAD"]) {
    const h = {};
    assert.throws(() => applyPostmanRawMedia(request("xml", { method }), h));
    assert.deepEqual(h, {});
  }
  const h = {};
  applyPostmanRawMedia(request("xml", { method: "GET", body: "" }), h);
  assert.deepEqual(h, {});
});
test("unmarked canonical raw is unchanged", () => {
  const r = request();
  delete r.postmanRawBody;
  const h = {};
  applyPostmanRawMedia(r, h);
  assert.deepEqual(h, {});
});
test("default identity differs from explicit text, unknown truthy labels use text", () => {
  for (const [label, expected] of [
    [undefined, "default"],
    ["", "default"],
    ["unknown", "text"],
    ["XML", "text"],
    ["text", "text"],
  ])
    assert.equal(
      importPostmanRawBody({
        mode: "raw",
        raw: "x",
        options: { raw: { language: label } },
      }).postmanRawBody.language,
      expected,
    );
});
test("profiles reject rather than guessing global folder item behavior", () => {
  assert.doesNotThrow(() => assertPostmanRawProfiles([undefined, {}]));
  for (const p of [
    { disableBodyPruning: true },
    { disabledSystemHeaders: { "content-type": true } },
    null,
  ])
    assert.throws(() => assertPostmanRawProfiles([undefined, p]));
});
test("marker malformed data and hooks reject without execution", () => {
  for (const value of [
    null,
    {},
    { version: 2, language: "xml" },
    { version: 1, language: "no" },
    { version: 1, language: "xml", extra: true },
  ])
    assert.throws(() => postmanRawBodyPolicy({ postmanRawBody: value }));
  let n = 0;
  assert.throws(() =>
    postmanRawBodyPolicy({
      get postmanRawBody() {
        n++;
        return {};
      },
    }),
  );
  const proxy = new Proxy(
    { version: 1, language: "xml" },
    {
      ownKeys() {
        n++;
        return [];
      },
    },
  );
  assert.throws(() => postmanRawBodyPolicy({ postmanRawBody: proxy }));
  assert.equal(n, 0);
});
test("raw imports reject invalid language, templates and new nonJSON option ambiguity", () => {
  for (const language of [null, false, {}, "{{language}}"])
    assert.throws(() =>
      importPostmanRawBody({
        mode: "raw",
        raw: "x",
        options: { raw: { language } },
      }),
    );
  assert.throws(() =>
    importPostmanRawBody({
      mode: "raw",
      raw: "x",
      options: { raw: { language: "xml", extra: 1 } },
    }),
  );
  assert.equal(
    importPostmanRawBody({
      mode: "raw",
      raw: "{}",
      options: { raw: { language: "json", extra: 1 }, extra: 1 },
    }).bodyType,
    "json",
  );
});
test("exports materialize default only on copies and preserve explicit empty curl headers", () => {
  const r = request(),
    before = structuredClone(r),
    out = postmanRawExportDefinition(r, { openapi: true });
  assert.deepEqual(r, before);
  assert.equal(out.headers[0].value, "application/xml");
  const explicit = request("xml", {
    headers: [{ key: "Content-Type", value: "", enabled: true }],
  });
  assert.equal(postmanRawExportDefinition(explicit).headers[0].value, "");
  assert.throws(() => postmanRawExportDefinition(explicit, { openapi: true }));
  assert.throws(() =>
    postmanRawExportDefinition(request("xml", { body: "" }), { openapi: true }),
  );
});
test("exports refuse scripts, dynamic bodies and unresolved body templates", () => {
  for (const extra of [
    { beforeScript: "pm.request.headers.clear()" },
    { sharedBeforeScripts: [{ name: "project", code: "x" }] },
    { before: [{ type: "set" }] },
    { body: "{{payload}}" },
    { bodyDynamic: { x: { source: "x" } } },
  ])
    assert.throws(() => postmanRawExportDefinition(request("xml", extra)));
});
test("marked JSON switch does not invent empty JSON payload", () => {
  assert.throws(() =>
    applyPostmanRawMedia(request("json", { bodyType: "json", body: "" }), {}),
  );
});
