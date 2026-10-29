// Reviewed data-only helpers: no application, network, VM or database execution.
import test from "node:test";
import assert from "node:assert/strict";
import { validateOpenAPIFormEncoding } from "../src/openapi-form-encoding.mjs";
import { importOpenAPIBody, exportOpenAPIBody } from "../src/openapi-body.mjs";
import {
  invalidEncodings,
  formMedia,
} from "./fixtures/openapi-form-encoding.mjs";
const schema = {
  type: "object",
  properties: { meta: { type: "string" }, "x-field": { type: "string" } },
};
test("whole encoding map rejects malformed entries and orphan keys, including keys absent from examples", () => {
  for (const encoding of invalidEncodings) {
    const media = { encoding };
    const before = structuredClone(media);
    assert.throws(() => validateOpenAPIFormEncoding(media, schema), /encoding/);
    assert.deepEqual(media, before);
  }
  assert.doesNotThrow(() => validateOpenAPIFormEncoding({ encoding: {} }, {}));
  assert.doesNotThrow(() =>
    validateOpenAPIFormEncoding({}, { properties: null }),
  );
  for (const properties of [null, false, "", [], 1])
    assert.throws(
      () => validateOpenAPIFormEncoding({ encoding: {} }, { properties }),
      /properties/,
    );
  assert.throws(
    () =>
      validateOpenAPIFormEncoding(
        { encoding: { inherited: {} } },
        { properties: Object.create({ inherited: {} }) },
      ),
    /已声明/,
  );
  assert.throws(
    () =>
      validateOpenAPIFormEncoding(
        { encoding: { meta: { "x-legal-extension": true } } },
        schema,
      ),
    /尚不支持/,
  );
});
test("absent and empty default encoding remain unchanged through form import/export/reimport", () => {
  for (const mime of formMedia)
    for (const extra of [
      {},
      { encoding: {} },
      { encoding: { meta: {}, "x-field": {} } },
    ]) {
      const body = {
        content: {
          [mime]: {
            schema,
            example: {
              meta: "雪 & +",
              "x-field": "literal",
              exampleOnly: "kept",
            },
            ...extra,
          },
        },
      };
      const before = structuredClone(body);
      const first = importOpenAPIBody(body);
      assert.deepEqual(body, before);
      assert(first.form.every((row) => !Object.hasOwn(row, "contentType")));
      const exported = exportOpenAPIBody({ ...first, headers: [] });
      const second = importOpenAPIBody(exported);
      assert.deepEqual(second.form, first.form);
      assert.equal(
        Object.hasOwn(exported.content[mime].schema.properties, "exampleOnly"),
        false,
      );
    }
});
test("encoding validation is selected-form-only and never infers MIME serialization", () => {
  for (const mime of formMedia)
    for (const encoding of invalidEncodings)
      assert.throws(
        () => importOpenAPIBody({ content: { [mime]: { schema, encoding } } }),
        /encoding/,
      );
  assert.equal(
    importOpenAPIBody({
      content: { "application/json": { example: "raw", encoding: null } },
    }).body,
    '"raw"',
  );
  assert.equal(
    importOpenAPIBody({
      content: { "text/plain": { example: "raw", encoding: false } },
    }).body,
    "raw",
  );
});
