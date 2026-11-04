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
