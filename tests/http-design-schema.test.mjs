import test from "node:test";
import assert from "node:assert/strict";
import {
  schemaRows,
  changeSchemaDescription,
  designSchemaHTML,
} from "../public/http-design-schema.js";
test("inline descriptions preserve complex schema keywords and source immutability", () => {
  const schema = {
    type: "object",
    required: ["name"],
    properties: {
      name: { $ref: "#/$defs/Name", description: "old" },
      list: {
        type: "array",
        items: { oneOf: [{ type: "string" }, { type: "null" }] },
      },
    },
    $defs: { Name: { type: "string", minLength: 2 } },
    additionalProperties: false,
  };
  const changed = changeSchemaDescription(
    schema,
    ["properties", "name"],
    "new",
  );
  assert.equal(schema.properties.name.description, "old");
  assert.equal(changed.properties.name.description, "new");
  changed.properties.name.description = "old";
  assert.deepEqual(changed, schema);
  assert.equal(schemaRows(schema).length, 4);
  assert.throws(() => changeSchemaDescription(schema, ["missing"], "x"));
  assert.throws(() => changeSchemaDescription(false, [], "x"));
});
test("schema tree escapes names descriptions refs and supports boolean schemas", () => {
  const html = designSchemaHTML({
    properties: {
      "<script>": { type: "string", description: '" onfocus="alert(1)' },
      flag: false,
    },
  });
  assert(!html.includes("<script>"));
  assert(!html.includes("style="));
  assert(html.includes("design-schema-depth-1"));
  assert(html.includes("&lt;script&gt;"));
  assert(html.includes("&quot; onfocus="));
  assert(html.includes("never"));
});
