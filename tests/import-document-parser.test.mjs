import test from "node:test";
import assert from "node:assert/strict";
import {
  parseImportDocumentText,
  IMPORT_DOCUMENT_MAX_BYTES,
} from "../src/import-document-parser.mjs";

test("shared parser preserves JSON values and bounded single-document YAML", () => {
  for (const value of [
    null,
    false,
    0,
    "openapi: 3.0.3",
    [],
    { openapi: "3.1.0", paths: {} },
  ])
    assert.deepEqual(parseImportDocumentText(JSON.stringify(value)), value);
  assert.deepEqual(parseImportDocumentText("openapi: 3.0.3\npaths: {}\n"), {
    openapi: "3.0.3",
    paths: {},
  });
  assert.deepEqual(
    parseImportDocumentText("a: &value [zero, one]\nb: *value"),
    { a: ["zero", "one"], b: ["zero", "one"] },
  );
});

test("malformed, duplicate keys, multiple YAML documents and alias amplification reject", () => {
  for (const source of [
    "openapi: [",
    "openapi: 3.0.3\nopenapi: 3.1.0",
    "---\nopenapi: 3.0.3\n---\npaths: {}",
    "a: &a [x,x,x,x,x,x,x,x,x,x]\nb: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a,*a]\nc: [*b,*b,*b,*b,*b,*b,*b,*b,*b,*b]",
  ])
    assert.throws(() => parseImportDocumentText(source));
  assert.throws(() => parseImportDocumentText({}), /字符串/);
});

test("text byte ceiling matches transport ceiling and counts UTF-8 bytes", () => {
  assert.equal(IMPORT_DOCUMENT_MAX_BYTES, 12 * 1024 * 1024);
  assert.throws(
    () => parseImportDocumentText(" ".repeat(IMPORT_DOCUMENT_MAX_BYTES + 1)),
    /12MiB/,
  );
  assert.throws(
    () =>
      parseImportDocumentText("界".repeat(IMPORT_DOCUMENT_MAX_BYTES / 3 + 1)),
    /12MiB/,
  );
});
