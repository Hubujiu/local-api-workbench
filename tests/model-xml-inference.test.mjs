import test from "node:test";
import assert from "node:assert/strict";
import { DOMParser } from "@xmldom/xmldom";
import { inferSchemaFromXML } from "../public/schema-inference.js";
import { sampleFromSchema } from "../src/core.mjs";

test("XML model inference shares the explicit JSON mapping without guessing text types", () => {
  const schema = inferSchemaFromXML(
    '<root id="7"><item>one</item><item><![CDATA[two<3]]></item><flag>true</flag><empty/></root>',
    DOMParser,
  );
  const expected = {
    root: { $: { id: "7" }, item: ["one", "two<3"], flag: "true", empty: "" },
  };
  assert.deepEqual(schema.example, expected);
  assert.deepEqual(sampleFromSchema(schema), expected);
  assert.equal(schema.properties.root.properties.flag.type, "string");
  assert.equal(schema.properties.root.required, undefined);
});
test("XML model inference rejects DTD entities malformed and mixed-content input before draft mutation", () => {
  for (const source of [
    '<!DOCTYPE r [<!ENTITY x SYSTEM "file:///fictional">]><r>&x;</r>',
    "<r>",
    "<r>mixed<c/></r>",
    "<r>&unknown;</r>",
    "<r>" + "中".repeat(22000) + "</r>",
    "<r>".repeat(22) + "x" + "</r>".repeat(22),
  ])
    assert.throws(() => inferSchemaFromXML(source, DOMParser));
  assert.throws(() => inferSchemaFromXML({}, DOMParser));
});
