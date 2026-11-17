import test from "node:test";
import assert from "node:assert/strict";
import {
  exportOpenAPIBody,
  importOpenAPIBody,
  exportOpenAPIHeaders,
  importOpenAPIHeaders,
} from "../src/openapi-body.mjs";

test("OAS3 import ignores reserved Content-Type parameters case-insensitively, using only the body media", () => {
  const parameters = [
    { in: "header", name: "CONTENT-TYPE", example: "wrong/type" },
    { in: "header", name: "content-type", example: "text/plain" },
    { in: "query", name: "Content-Type", example: "not-a-header" },
    { in: "header", name: "X-Trace", example: "kept", required: true },
    // Accept/auth conversion is not expanded by this bounded Content-Type fix.
    { in: "header", name: "Accept", example: "application/json" },
    { in: "header", name: "Authorization", example: "unchanged" },
  ];
  const before = structuredClone(parameters);
  const headers = importOpenAPIHeaders(parameters, "application/json");
  assert.deepEqual(
    headers.map(({ key }) => key),
    ["X-Trace", "Accept", "Authorization", "Content-Type"],
  );
  assert.equal(headers[0].value, "kept");
  assert.equal(headers[0].required, true);
  assert.equal(headers.at(-1).value, "application/json");
  assert.equal(importOpenAPIHeaders(parameters, "").length, 3);
  assert.deepEqual(parameters, before);
  assert.equal(
    importOpenAPIHeaders(parameters, "", { ignoreContentType: false }).length,
    5,
    "the Swagger parameter path is not changed by the OAS3 reserved-header rule",
  );
});

test("supported body media roundtrip as one Content-Type, never a redundant header parameter", () => {
  for (const [bodyType, media, body] of [
    ["json", "application/json", '{"value":false}'],
    ["json", "Application/Problem+Json; charset=utf-8", '{"value":0}'],
    ["raw", "text/plain; charset=utf-8", "中文 +"],
    ["raw", "application/example+xml", "<literal/>"],
  ]) {
    const request = {
      bodyType,
      body,
      headers: [
        { key: "cOnTeNt-TyPe", value: media, enabled: true },
        { key: "X-Trace", value: "kept", enabled: true },
      ],
    };
    const before = structuredClone(request);
    const parameters = exportOpenAPIHeaders(request).map(({ key, value }) => ({
      in: "header",
      name: key,
      example: value,
    }));
    assert.deepEqual(parameters, [
      { in: "header", name: "X-Trace", example: "kept" },
    ]);
    const imported = importOpenAPIBody(exportOpenAPIBody(request));
    assert.equal(imported.bodyType, bodyType);
    assert.equal(imported.contentType, media);
    assert.deepEqual(
      importOpenAPIHeaders(parameters, imported.contentType).map(
        ({ key, value }) => [key, value],
      ),
      [
        ["X-Trace", "kept"],
        ["Content-Type", media],
      ],
    );
    if (bodyType === "json")
      assert.deepEqual(JSON.parse(imported.body), JSON.parse(body));
    else assert.equal(imported.body, body);
    assert.deepEqual(request, before, "export never deletes canonical headers");
  }
});

test("OpenAPI form export preserves an explicit urlencoded charset media instead of silently resetting it", () => {
  const media = "application/x-www-form-urlencoded; charset=utf-8";
  const request = {
    bodyType: "urlencoded",
    headers: [{ key: "cOnTeNt-TyPe", value: media }],
    form: [{ key: "name", value: "中文 +", type: "text", enabled: true }],
  };
  const body = exportOpenAPIBody(request);
  assert.deepEqual(exportOpenAPIHeaders(request), []);
  assert.deepEqual(Object.keys(body.content), [media]);
  const imported = importOpenAPIBody(body);
  assert.equal(imported.contentType, media);
  assert.equal(imported.bodyType, "urlencoded");
  assert.equal(imported.form[0].value, "中文 +");
  assert.deepEqual(importOpenAPIHeaders([], imported.contentType), [
    { key: "Content-Type", value: media, enabled: true },
  ]);
});

test("disabled Content-Type is not a conflict; multipart retains the generated-boundary contract", () => {
  const disabled = { key: "Content-Type", value: "wrong/type", enabled: false };
  const request = {
    bodyType: "json",
    body: "{}",
    headers: [disabled, { key: "content-type", value: "application/json" }],
  };
  assert.deepEqual(Object.keys(exportOpenAPIBody(request).content), [
    "application/json",
  ]);
  assert.deepEqual(exportOpenAPIHeaders(request), []);
  const none = { bodyType: "none", headers: [disabled] };
  assert.equal(exportOpenAPIBody(none), undefined);
  assert.deepEqual(exportOpenAPIHeaders(none), []);
  const multipart = {
    bodyType: "form-data",
    form: [{ key: "name", value: "hello", type: "text" }],
    headers: [{ key: "CONTENT-TYPE", value: "MULTIPART/FORM-DATA" }],
  };
  const imported = importOpenAPIBody(exportOpenAPIBody(multipart));
  assert.equal(imported.bodyType, "form-data");
  assert.equal(imported.form[0].value, "hello");
  assert.equal(imported.contentType, "");
  assert.deepEqual(exportOpenAPIHeaders(multipart), []);
});

test("OpenAPI export rejects duplicate or nonrepresentable explicit Content-Type rather than normalizing away semantics", () => {
  for (const request of [
    {
      bodyType: "json",
      body: "{}",
      headers: [
        { key: "Content-Type", value: "application/json" },
        { key: "content-type", value: "application/json" },
      ],
    },
    {
      bodyType: "json",
      body: '"text"',
      headers: [{ key: "Content-Type", value: "text/plain" }],
    },
    {
      bodyType: "raw",
      body: '{"raw":true}',
      headers: [{ key: "Content-Type", value: "application/json" }],
    },
    {
      bodyType: "urlencoded",
      form: [],
      headers: [{ key: "Content-Type", value: "text/plain" }],
    },
    {
      bodyType: "form-data",
      form: [],
      headers: [
        { key: "Content-Type", value: "multipart/form-data; boundary=custom" },
      ],
    },
    {
      bodyType: "none",
      headers: [{ key: "Content-Type", value: "text/plain" }],
    },
    {
      bodyType: "json",
      body: "{}",
      headers: [{ key: "Content-Type", value: "" }],
    },
    {
      bodyType: "json",
      body: "{}",
      headers: [
        { key: "Content-Type", value: "application/json\r\nx-extra:x" },
      ],
    },
    {
      bodyType: "json",
      body: "{}",
      headers: [
        {
          key: "Content-Type",
          value: "application/json",
          dynamic: { source: "value" },
        },
      ],
    },
  ]) {
    const before = structuredClone(request);
    assert.throws(() => exportOpenAPIBody(request), /Content-Type/);
    assert.throws(() => exportOpenAPIHeaders(request), /Content-Type/);
    assert.deepEqual(request, before);
  }
});
