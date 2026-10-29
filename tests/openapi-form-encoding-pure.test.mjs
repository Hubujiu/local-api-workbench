// Reviewed data-only helpers: no application, network, VM or database execution.
import test from "node:test";
import assert from "node:assert/strict";
import { validateOpenAPIFormEncoding } from "../src/openapi-form-encoding.mjs";
import { importOpenAPIBody, exportOpenAPIBody } from "../src/openapi-body.mjs";
import {
  invalidEncodings,
  formMedia,
  transferDocument,
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

test("multipart transfer declarations fail closed without mutating data; version annotations stay literal", () => {
  const body = (definition, mime = "multipart/form-data") => ({
    content: {
      [mime]: {
        schema: { type: "object", properties: { meta: definition } },
        example: { meta: "AP8=" },
      },
    },
  });
  for (const contentEncoding of [
    "base64",
    "base64url",
    "quoted-printable",
    "identity",
    "",
    null,
    false,
    [],
    {},
  ]) {
    for (const openapi of ["3.0.3", "3.1.0", "3.1.1"]) {
      const input = body({ type: "string", contentEncoding });
      const before = structuredClone(input);
      assert.throws(
        () => importOpenAPIBody(input, { openapi }),
        /contentEncoding/,
      );
      assert.deepEqual(input, before);
    }
    for (const type of ["text", "file"]) {
      const request = {
        bodyType: "form-data",
        form: [
          {
            key: "meta",
            value: "AP8=",
            type,
            schema: { type: "string", contentEncoding },
          },
        ],
      };
      const before = structuredClone(request);
      assert.throws(() => exportOpenAPIBody(request), /contentEncoding/);
      assert.deepEqual(request, before);
    }
  }
  assert.throws(
    () => importOpenAPIBody(body({ type: "string", format: "byte" })),
    /format:byte/,
  );
  for (const format of ["byte", "binary", "uuid"]) {
    const imported = importOpenAPIBody(body({ type: "string", format }), {
      openapi: "3.1.0",
    });
    assert.equal(imported.form[0].type, "text");
    assert.equal(imported.form[0].value, "AP8=");
    assert.equal(Object.hasOwn(imported.form[0], "requiresFile"), false);
    if (format !== "uuid")
      assert.throws(() => exportOpenAPIBody(imported), /format:/);
  }
  const binary = importOpenAPIBody(body({ type: "string", format: "binary" }));
  assert.equal(binary.form[0].type, "file");
  assert.equal(binary.form[0].requiresFile, true);
  assert.deepEqual(
    importOpenAPIBody(exportOpenAPIBody(binary)).form,
    binary.form,
  );
  // This change does not expand URL-encoded binary support.
  assert.throws(
    () =>
      importOpenAPIBody(
        body(
          { type: "string", format: "binary" },
          "application/x-www-form-urlencoded",
        ),
        { openapi: "3.1.0" },
      ),
    /文件字段需要/,
  );
  const encoded = importOpenAPIBody(
    body(
      { type: "string", format: "byte" },
      "application/x-www-form-urlencoded",
    ),
  );
  assert.equal(encoded.form[0].value, "AP8=");
  assert.deepEqual(
    importOpenAPIBody(exportOpenAPIBody(encoded)).form,
    encoded.form,
  );
  for (const mime of ["application/json", "text/plain"]) {
    const input = {
      content: {
        [mime]: {
          schema: { type: "string", contentEncoding: "base64" },
          example: "AP8=",
        },
      },
    };
    assert.equal(
      importOpenAPIBody(input, { openapi: "3.1.0" }).body,
      mime === "application/json" ? '"AP8="' : "AP8=",
    );
  }
});

test("mixed transfer fixture begins with a genuinely valid operation", () => {
  const doc = transferDocument(
    "http://example.test",
    "3.1.0",
    { type: "string", contentEncoding: "base64" },
    "multipart/form-data",
    true,
  );
  assert.equal(Object.keys(doc.paths)[0], "/valid-first");
  const imported = importOpenAPIBody(
    doc.paths["/valid-first"].post.requestBody,
    { openapi: doc.openapi },
  );
  assert.equal(imported.form[0].type, "text");
  assert.equal(imported.form[0].value, "雪 & +");
});
