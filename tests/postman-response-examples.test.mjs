import test from "node:test";
import assert from "node:assert/strict";
import { importPostmanResponseExamples } from "../src/postman-response-examples.mjs";
import {
  appendResponseExamples,
  importResponseExamples,
} from "../src/openapi-response-examples.mjs";
const response = (type = "text/plain", body = "not-json: 雪😀") => ({
  name: "reply",
  code: 200,
  body,
  header: [
    { key: "Content-Type", value: type },
    { key: "X-Reply", value: "retained" },
  ],
});
test("Postman response examples preserve active safe headers, raw text and JSON values across the media exporter", () => {
  for (const [type, body] of [
    ["text/plain", "not-json: 雪😀"],
    ["text/plain", ""],
    ["application/json", "false"],
    ["application/json", "0"],
    ["application/json", "null"],
    ["application/problem+json", '{ "ok": true }'],
  ]) {
    const source = [response(type, body)],
      before = structuredClone(source);
    const [example] = importPostmanResponseExamples(source);
    assert.equal(example.body, body);
    assert.deepEqual(example.headers, {
      "content-type": type,
      "x-reply": "retained",
    });
    const output = {};
    appendResponseExamples(output, [example]);
    const [roundtrip] = importResponseExamples(output).examples;
    assert.equal(roundtrip.headers["content-type"], type);
    if (type.includes("json"))
      assert.deepEqual(JSON.parse(roundtrip.body), JSON.parse(body));
    else assert.equal(roundtrip.body, body);
    assert.deepEqual(source, before);
  }
});
test("missing/null/empty headers retain the old default without guessing text media, while disabled rows are inactive", () => {
  for (const header of [
    undefined,
    null,
    "",
    [],
    [{ key: "Content-Type", value: "text/plain", disabled: true }],
  ]) {
    const [example] = importPostmanResponseExamples([
      { name: "absent", code: 200, body: "not-json", header },
    ]);
    assert.equal(Object.hasOwn(example, "headers"), false);
    assert.throws(() => appendResponseExamples({}, [example]), /JSON/);
  }
  const value = response();
  value.header.push(
    { key: "CONTENT-TYPE", value: "application/octet-stream", disabled: true },
    { key: "Set-Cookie", value: "secret=hidden", disabled: true },
  );
  assert.equal(
    importPostmanResponseExamples([value])[0].headers["content-type"],
    "text/plain",
  );
  assert.deepEqual(importPostmanResponseExamples([{ body: null }]), [
    { name: undefined, status: 200, body: "" },
  ]);
});
test("unsupported raw headers, duplicate names, unsafe headers and binary media reject without modifying mixed source", () => {
  const invalid = [
    { ...response(), header: "Content-Type: text/plain\r\n" },
    { ...response(), header: ["Content-Type: text/plain"] },
    {
      ...response(),
      header: [
        { key: "X-A", value: "one" },
        { key: "x-a", value: "two" },
      ],
    },
    {
      ...response(),
      header: [{ key: "X-A", value: "one", disabled: "false" }],
    },
    { ...response(), header: [{ key: "Content-Length", value: "1" }] },
    { ...response(), header: [{ key: "Set-Cookie", value: "secret=1" }] },
    { ...response(), header: [{ key: "X-A", value: "one\r\nInjected: yes" }] },
    response("application/octet-stream", "AAAA"),
    response("image/png", "PNG"),
    response("application/json", "{bad"),
    response("not-media", "x"),
    { ...response(), code: 0 },
    { ...response(), body: false },
  ];
  for (const bad of invalid) {
    const source = [response(), bad],
      before = structuredClone(source);
    assert.throws(() => importPostmanResponseExamples(source));
    assert.deepEqual(source, before);
  }
});
test("prototype-sensitive header names are own data, and text validation remains authoritative", () => {
  const source = response();
  source.header.push(
    { key: "__proto__", value: "literal" },
    { key: "constructor", value: "also-literal" },
  );
  const example = importPostmanResponseExamples([source])[0];
  assert.equal(Object.hasOwn(example.headers, "__proto__"), true);
  assert.equal(example.headers.__proto__, "literal");
  assert.equal(example.headers.constructor, "also-literal");
  assert.equal(Object.getPrototypeOf(example.headers), Object.prototype);
  assert.throws(
    () => importPostmanResponseExamples([response("text/plain", "\ud800")]),
    /文本/,
  );
});
