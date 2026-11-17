import test from "node:test";
import assert from "node:assert/strict";
import {
  validateMultipartPartMedia,
  assertMultipartMediaExportable,
  postmanPartMedia,
  multipartPartMedia,
} from "../src/multipart-part-media.mjs";
const request = (value, extra = {}) => ({
  bodyType: "form-data",
  form: [{ key: "meta", value: "{}", contentType: value, ...extra }],
});
test("literal multipart media preserves case, parameters and source bytes without inventing defaults", () => {
  for (const value of [
    'Application/JSON; charset="utf-8"',
    "application/vnd.fixture+json",
    'text/plain; title="a;b"',
    "image/png",
  ]) {
    const r = request(value),
      before = JSON.stringify(r);
    validateMultipartPartMedia(r);
    assert.equal(JSON.stringify(r), before);
    assert.deepEqual(postmanPartMedia(r.form[0]), { contentType: value });
  }
  const old = { bodyType: "form-data", form: [{ key: "x", value: "a" }] },
    bytes = JSON.stringify(old);
  validateMultipartPartMedia(old);
  assert.equal(JSON.stringify(old), bytes);
  assert.deepEqual(postmanPartMedia(old.form[0]), {});
  assert.doesNotThrow(() => assertMultipartMediaExportable(old, "cURL"));
});
test("multipart media rejects malformed, oversized, dynamic and unsafe values including disabled rows", () => {
  for (const value of [
    undefined,
    null,
    false,
    42,
    {},
    [],
    "",
    " ",
    " text/plain",
    "text/plain ",
    "text",
    "text/",
    "*/json",
    "application/*",
    "application/j*son",
    "text/plain\r\nX-Foo: x",
    "text/plain\0",
    "text/plain\t",
    "text/雪",
    'text/plain; charset="{{charset}}"',
    "{{mime}}",
    "text/plain; bad",
    'text/plain; title="unterminated',
    "text/plain; title=" + "x".repeat(1024),
  ])
    for (const enabled of [true, false])
      assert.throws(
        () => validateMultipartPartMedia(request(value, { enabled })),
        /Content-Type/,
      );
  for (const bodyType of [undefined, "none", "raw", "urlencoded", "binary"])
    assert.throws(
      () => validateMultipartPartMedia({ ...request("text/plain"), bodyType }),
      /Content-Type/,
    );
});
test("unsupported exports reject own media presence including disabled or malformed fields", () => {
  for (const value of [undefined, "", "application/json"])
    for (const enabled of [true, false])
      for (const format of ["OpenAPI", "cURL"])
        assert.throws(
          () =>
            assertMultipartMediaExportable(request(value, { enabled }), format),
          /不能保留/,
        );
});

test("prototype-only media cannot become a part header after own-property validation", () => {
  const row = Object.assign(
    Object.create({ contentType: "text/plain\r\nX: injected" }),
    { key: "x", value: "a" },
  );
  validateMultipartPartMedia({ bodyType: "form-data", form: [row] });
  assert.deepEqual(postmanPartMedia(row), {});
  assert.equal(multipartPartMedia(row, false), undefined);
  assert.equal(multipartPartMedia(row, true), "application/octet-stream");
  assert.equal(
    multipartPartMedia({ contentType: "application/json" }, false),
    "application/json",
  );
});
