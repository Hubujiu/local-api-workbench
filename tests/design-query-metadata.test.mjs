import assert from "node:assert/strict";
import test from "node:test";
import {
  designQueryMetadata,
  designQueryMetadataHTML,
  designQueryTypeMenuHTML,
  prepareDesignQueryType,
} from "../public/design-query-metadata.js";
import { appendRequestQuery } from "../src/query-serialization.mjs";

test("real named rows expose only the actually present metadata or the scalar default", () => {
  assert.equal(designQueryMetadata({ key: "   " }), null);
  assert.deepEqual(designQueryMetadata({ key: "n" }), {
    type: "string",
    required: false,
  });
  assert.deepEqual(
    designQueryMetadata({
      key: "n",
      required: true,
      schema: { type: "integer" },
    }),
    { type: "integer", required: true },
  );
  for (const schema of [
    { type: "object" },
    { type: "array" },
    { type: ["number", "null"] },
    { $ref: "fixture" },
    { type: "string", oneOf: [] },
    true,
    {},
  ]) {
    assert.equal(designQueryMetadata({ key: "n", schema }).type, null);
  }
  for (const mark of [
    "querySerialization",
    "queryObjectSerialization",
    "reservedQuerySerialization",
  ])
    assert.equal(
      designQueryMetadata({ key: "n", schema: { type: "string" }, [mark]: {} })
        .type,
      null,
    );
  assert.equal(designQueryMetadataHTML({ key: "" }, 0, String), "");
  assert.doesNotMatch(
    designQueryTypeMenuHTML(),
    /data-design-query-option="(object|array|null|any)"/,
  );
});

test("switching scalar type cannot drop incompatible format, constraints or examples", () => {
  for (const schema of [
    { type: "string", format: "uuid" },
    { type: "string", minLength: 2 },
    { type: "string", example: "zero" },
    { type: "number", enum: [1, 0.5] },
  ]) {
    const source = { key: "n", schema };
    const before = structuredClone(source);
    assert.throws(
      () => prepareDesignQueryType(source, "integer"),
      /使用「定义」/,
    );
    assert.deepEqual(source, before);
  }
  const source = {
    key: "n",
    value: "42",
    required: true,
    description: "retained",
    schema: { type: "number", minimum: 0, enum: [0, 42], title: "Keep" },
  };
  assert.equal(prepareDesignQueryType(source, "number"), null);
  const next = { ...source, schema: prepareDesignQueryType(source, "integer") };
  assert.deepEqual(next.schema, { ...source.schema, type: "integer" });
  assert.equal(next.description, source.description);
  assert.equal(next.value, source.value);
  assert.equal(
    appendRequestQuery(new URL("http://127.0.0.1/"), [source]).search,
    "?n=42",
  );
  assert.equal(
    appendRequestQuery(new URL("http://127.0.0.1/"), [next]).search,
    "?n=42",
  );
  assert.equal(
    appendRequestQuery(new URL("http://127.0.0.1/"), [
      { ...next, enabled: false },
    ]).search,
    "",
  );
});
