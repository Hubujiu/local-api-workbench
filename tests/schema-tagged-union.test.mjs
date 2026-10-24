import test from "node:test";
import assert from "node:assert/strict";
import Ajv2020 from "ajv/dist/2020.js";
import { sampleFromSchema } from "../src/schema-sample.mjs";

const branch = (tag, properties = {}) => ({
  type: "object",
  required: ["kind"],
  properties: { kind: tag, ...properties },
});
function assertValid(schema) {
  const before = structuredClone(schema),
    value = sampleFromSchema(schema);
  assert(
    new Ajv2020({ strict: false }).compile(schema)(value),
    JSON.stringify(value),
  );
  assert.deepEqual(schema, before);
  return value;
}

test("oneOf can generate objects distinguished by required disjoint string tags", () => {
  const schema = {
    type: "object",
    required: ["shared"],
    properties: { shared: { type: "integer", minimum: 3 } },
    oneOf: [
      branch({ const: "cat" }, { lives: { type: "integer", minimum: 9 } }),
      branch({ enum: ["dog", "wolf"] }, { barks: { type: "boolean" } }),
    ],
  };
  assert.deepEqual(assertValid(schema), { shared: 3, kind: "cat", lives: 9 });
  const second = {
    oneOf: [
      { ...branch({ enum: ["cat"] }), maxProperties: 0 },
      branch({ enum: ["dog", "wolf"] }),
    ],
  };
  assert.equal(assertValid(second).kind, "dog");
});

test("tagged unions require actual nonoverlapping constraints, not a discriminator hint", () => {
  for (const schema of [
    { oneOf: [branch({ enum: ["cat", "dog"] }), branch({ const: "dog" })] },
    {
      oneOf: [
        { ...branch({ const: "cat" }), required: [] },
        branch({ const: "dog" }),
      ],
    },
    {
      discriminator: { propertyName: "kind" },
      oneOf: [branch({ type: "string" }), branch({ type: "string" })],
    },
    {
      oneOf: [
        branch({ const: "cat", pattern: "^dog$" }),
        branch({ const: "dog" }),
      ],
    },
    { oneOf: [branch({ enum: Array(1) }), branch({ const: "dog" })] },
    {
      oneOf: [
        branch({ const: "cat", enum: ["dog"] }),
        branch({ const: "dog" }),
      ],
    },
    { oneOf: [branch({ enum: ["cat", "cat"] }), branch({ const: "dog" })] },
  ])
    assert.throws(() => sampleFromSchema(schema), /oneOf|example/);
});

test("tag verification catches illustrative field overrides and keeps original budgets", () => {
  const schema = {
    oneOf: [
      branch({ enum: ["cat"], example: "other" }),
      branch({ enum: ["dog"], default: "other" }),
    ],
  };
  assert.throws(() => sampleFromSchema(schema), /oneOf|example/);
  const mocked = {
    oneOf: [branch({ const: "cat" }), branch({ const: "dog" })],
  };
  assert.throws(
    () =>
      sampleFromSchema(mocked, 0, mocked, {
        valueForField: (name, schema) =>
          schema.type === "object" && !schema.oneOf
            ? { kind: "wrong" }
            : undefined,
      }),
    /oneOf|example/,
  );
  const tooMany = {
    oneOf: Array.from({ length: 17 }, (_, i) => branch({ const: String(i) })),
  };
  assert.throws(() => sampleFromSchema(tooMany), /16/);
  const required = Array.from({ length: 32 }, (_, i) => "tag" + i);
  const properties = Object.fromEntries(
    required.map((name) => [
      name,
      { enum: Array.from({ length: 100 }, (_, i) => String(i)) },
    ]),
  );
  const bounded = {
    oneOf: Array.from({ length: 16 }, () => ({
      type: "object",
      required,
      properties,
    })),
  };
  assert.throws(() => sampleFromSchema(bounded), /上限/);
});
