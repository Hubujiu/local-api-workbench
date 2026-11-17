import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { draft7MetaPlugin } from "../scripts/precompile-schema-meta.mjs";

const vectors = [
  true,
  false,
  {},
  { type: "string" },
  { type: 17 },
  { type: [] },
  { type: ["string", "string"] },
  { required: "x" },
  { required: ["x", "x"] },
  { maximum: "2" },
  { minItems: -1 },
  { multipleOf: 0 },
  { uniqueItems: "yes" },
  { enum: [] },
  { enum: [1, 1] },
  { pattern: "[" },
  { format: "email" },
  { properties: { child: { type: 4 } } },
  { definitions: { child: { required: 4 } } },
  { items: [{ type: "integer" }, false] },
  { items: [17] },
  { dependencies: { x: ["a", "a"] } },
  { dependencies: { x: false } },
  { allOf: [] },
  { anyOf: [true, false] },
  { not: 17 },
  { if: { type: "string" }, then: { minLength: 2 }, else: false },
  { $ref: "#/definitions/x", definitions: { x: { type: "integer" } } },
  { $schema: "http://json-schema.org/draft-07/schema#", type: "object" },
  { $id: "urn:test:meta", title: 1, description: 2, readOnly: "yes" },
];

test("precompiled Draft 7 self-validation equals pinned Ajv for all supported option combinations", async () => {
  for (const allErrors of [false, true])
    for (const verbose of [false, true]) {
      const optionKey = `${Number(allErrors)}${Number(verbose)}`;
      const bundle = await build({
        stdin: {
          contents: `import validate from 'trusted-draft7-meta:${optionKey}'; globalThis.validateMeta = validate;`,
          resolveDir: process.cwd(),
        },
        plugins: [draft7MetaPlugin()],
        bundle: true,
        write: false,
        platform: "browser",
        format: "iife",
        target: "es2022",
      });
      const sandbox = {};
      runInNewContext(bundle.outputFiles[0].text, sandbox, { timeout: 1000 });
      const oracle = new Ajv({
        allErrors,
        verbose,
        strict: false,
        logger: false,
        ownProperties: true,
      });
      addFormats(oracle, { keywords: false });
      const validate = oracle.getSchema(
        "http://json-schema.org/draft-07/schema",
      );
      for (const schema of vectors) {
        const expected = validate(schema);
        assert.equal(
          sandbox.validateMeta(schema),
          expected,
          JSON.stringify({ schema, optionKey }),
        );
        assert.deepEqual(
          JSON.parse(JSON.stringify(sandbox.validateMeta.errors)),
          JSON.parse(JSON.stringify(validate.errors)),
          JSON.stringify({ schema, optionKey }),
        );
      }
    }
});
