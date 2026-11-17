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

test("native browser XML error documents are rejected across Gecko and WebKit namespaces", () => {
  for (const namespace of [
    "http://www.mozilla.org/newlayout/xml/parsererror.xml",
    "http://www.w3.org/1999/xhtml",
  ]) {
    class NativeErrorParser {
      parseFromString() {
        return new DOMParser().parseFromString(
          `<parsererror xmlns="${namespace}"><h3>XML parsing error</h3></parsererror>`,
          "application/xml",
        );
      }
    }
    assert.throws(
      () => inferSchemaFromXML("<root>", NativeErrorParser),
      /XML格式错误/,
    );
  }
  assert.deepEqual(
    inferSchemaFromXML(
      "<parsererror>ordinary user element</parsererror>",
      DOMParser,
    ).example,
    { parsererror: "ordinary user element" },
  );
});
