import test from "node:test";
import { validateResources } from "../src/resources.mjs";
import assert from "node:assert/strict";
import { importIntoProject } from "../src/core.mjs";
import { exportApipost } from "../src/apipost-export.mjs";
import { exportApipostDirectory } from "../src/apipost-directory-export.mjs";
import {
  blankAttributeProject,
  emittedAttributes,
} from "./fixtures/apipost-export-attributes.mjs";
import { emittedCatalogue as emittedCodes } from "./fixtures/apipost-codes.mjs";
import { emittedCatalogue as emittedDescriptions } from "./fixtures/apipost-descriptions.mjs";
import {
  combinedDocument,
  catalogueSemantics,
} from "./fixtures/apipost-attribute-catalogues.mjs";
const formats = [
  ["apipost", exportApipost],
  ["apipost-directory", exportApipostDirectory],
];
function fixture() {
  const p = blankAttributeProject("combined-source");
  importIntoProject(p, combinedDocument("http://127.0.0.1:1/never"));
  return p;
}

for (const [format, encode] of formats)
  test(`${format} keeps attributes, codes and parameter descriptions independent through two serialized generations`, () => {
    const source = fixture(),
      expected = catalogueSemantics(source),
      before = structuredClone(source);
    let p = source;
    for (let i = 0; i < 2; i++) {
      const snapshot = structuredClone(p),
        output = JSON.parse(JSON.stringify(encode(p))),
        attrs = emittedAttributes(output, format),
        codes = emittedCodes(output, format),
        descs = emittedDescriptions(output, format);
      assert.equal(attrs.projectId, codes.projectId);
      assert.equal(attrs.projectId, descs.projectId);
      assert.ok(descs.rows.every((d) => d.project_id === attrs.projectId));
      assert.ok(attrs.fields.every((d) => d.project_id === attrs.projectId));
      assert.equal(
        new Set([
          ...attrs.fields.map((f) => f.attribute_id),
          ...descs.rows.map((d) => d.id),
        ]).size,
        attrs.fields.length + descs.rows.length,
      );
      assert.ok(
        codes.rows.every(
          (c) => Object.keys(c).sort().join(",") === "code_msg,code_number",
        ),
      );
      const ids = new Set(attrs.fields.map((f) => f.attribute_id));
      assert.ok(
        attrs.apis.every((a) =>
          Object.keys(a.attribute_info).every((k) => ids.has(k)),
        ),
      );
      const next = blankAttributeProject("target-" + i);
      importIntoProject(next, output);
      assert.deepEqual(catalogueSemantics(next), expected);
      assert.equal(Object.hasOwn(next.settings, "is_describe_library"), false);
      assert.equal(next.requests.length, 2);
      assert.deepEqual(p, snapshot);
      p = next;
    }
    assert.deepEqual(source, before);
    assert.deepEqual(source.settings.statusCodes[0].apipostSource, {
      projectId: "attribute-source",
      codeId: "old-code",
    });
    assert.deepEqual(source.settings.parameterDescriptions[0].apipostSource, {
      projectId: "attribute-source",
      id: "old-description",
    });
    assert.deepEqual(source.settings.attributes[0].apipostSource, {
      projectId: "attribute-source",
      attributeId: "field-0",
      sort: 0,
    });
  });

test("an invalid member of any catalogue refuses the entire combined export without changes", () => {
  for (const change of [
    (p) => (p.settings.statusCodes[0].httpHint = true),
    (p) => (p.settings.parameterDescriptions[0].unknown = true),
    (p) => (p.settings.attributes[8].required = false),
    (p) => (p.requests[0].attributes.unknown = null),
    (p) => (p.settings.attributes[0].apipostSource.unknown = true),
  ]) {
    const p = fixture();
    change(p);
    const before = structuredClone(p);
    for (const [, encode] of formats) assert.throws(() => encode(p));
    assert.deepEqual(p, before);
  }
});

test("combined export retains the separate description budget while codes can exceed one MiB and attributes keep their own bounds", () => {
  const p = fixture();
  p.settings.statusCodes = Array.from({ length: 2000 }, (_, i) => ({
    code: "c" + i,
    label: "v".repeat(600),
  }));
  const expected = catalogueSemantics(p);
  for (const [format, encode] of formats) {
    const output = JSON.parse(JSON.stringify(encode(p)));
    assert.ok(
      Buffer.byteLength(JSON.stringify(emittedCodes(output, format).rows)) >
        1024 * 1024,
    );
    const next = blankAttributeProject("large");
    importIntoProject(next, output);
    assert.deepEqual(catalogueSemantics(next), expected);
  }
  const largeDescriptions = structuredClone(p);
  largeDescriptions.settings.parameterDescriptions = Array.from(
    { length: 2000 },
    (_, i) => ({ key: "k" + i, description: "d".repeat(600) }),
  );
  for (const [, encode] of formats)
    assert.throws(() => encode(largeDescriptions), /1\s?MiB/);
  p.settings.attributes[0].description = "x".repeat(2001);
  for (const [, encode] of formats) assert.throws(() => encode(p), /属性/);
});

test("joint owner negative fixtures distinguish storage admission from export rejection", () => {
  const p = fixture();
  for (const mutate of [
    (q) => (q.settings.statusCodes[1].httpHint = true),
    (q) => (q.settings.attributes[8].required = false),
  ]) {
    const changed = structuredClone(p);
    mutate(changed);
    assert.doesNotThrow(() => validateResources(changed.settings));
    for (const [, encode] of formats) assert.throws(() => encode(changed));
  }
  const invalidDescription = structuredClone(p);
  invalidDescription.settings.parameterDescriptions[0].unknown = true;
  assert.throws(() => validateResources(invalidDescription.settings));
});
