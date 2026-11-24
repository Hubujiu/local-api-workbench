import assert from "node:assert/strict";
import test from "node:test";
import {
  formFileRepresentation,
  unsupportedURLencodedForm,
  prepareFormTypeChange,
  formTextExample,
} from "../public/form-field-types.js";

test("a deliberate conversion discards incompatible payload without changing the original or neutral metadata", () => {
  const file = {
    type: "file",
    value: "c3ludGhldGlj",
    filename: "synthetic.bin",
    requiresFile: false,
    enabled: false,
    key: "input",
    description: "example",
    required: true,
    schema: { type: "string" },
  };
  const next = prepareFormTypeChange(file, "text", "form-data");
  assert.equal(next.confirm, true);
  assert.deepEqual(next.row, {
    type: "text",
    value: "",
    enabled: false,
    key: "input",
    description: "example",
    required: true,
    schema: { type: "string" },
  });
  assert.equal(file.value, "c3ludGhldGlj");
  const selected = prepareFormTypeChange(
    { ...next.row, value: "ordinary text" },
    "file",
    "form-data",
  );
  assert.equal(selected.confirm, true);
  assert.equal(selected.row.value, "");
  assert.equal(selected.row.requiresFile, true);
  assert.equal(
    prepareFormTypeChange(selected.row, "text", "form-data").confirm,
    false,
  );
  assert.throws(
    () => prepareFormTypeChange(next.row, "file", "urlencoded"),
    /multipart/,
  );
});

test("legacy file marker and immutable multipart media block encoding; safe text examples are unchanged", () => {
  assert.equal(
    formFileRepresentation({ type: "text", filename: "", requiresFile: false }),
    false,
  );
  for (const file of [
    { type: "file" },
    { type: "text", filename: "synthetic.bin" },
    { requiresFile: true },
  ]) {
    const row = { ...file, value: "c3ludGhldGlj", enabled: false };
    assert(unsupportedURLencodedForm([row]));
    assert.equal(formTextExample(row), "");
  }
  for (const metadata of [
    { contentType: "application/octet-stream" },
    { schema: { type: "string", format: "binary" } },
    { dynamic: { source: "fixed", value: "text" } },
  ]) {
    const row = { type: "file", ...metadata };
    assert.throws(
      () => prepareFormTypeChange(row, "text", "form-data"),
      /保留原字段并新增/,
    );
  }
  assert(
    unsupportedURLencodedForm([
      { type: "text", contentType: "text/plain", enabled: false },
    ]),
  );
  assert.equal(
    unsupportedURLencodedForm([{ value: "ordinary", requiresFile: false }]),
    false,
  );
  assert.equal(
    formTextExample({ type: "text", value: "ordinary" }),
    "ordinary",
  );
});
