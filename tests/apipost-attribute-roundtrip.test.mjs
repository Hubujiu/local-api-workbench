import test from "node:test";
import assert from "node:assert/strict";
import { importIntoProject } from "../src/core.mjs";
import { exportApipost } from "../src/apipost-export.mjs";
import { exportApipostDirectory } from "../src/apipost-directory-export.mjs";
import {
  attributeDocument,
  blankAttributeProject,
  attributeSemantics,
  emittedAttributes,
} from "./fixtures/apipost-export-attributes.mjs";

for (const [format, encode] of [
  ["apipost", exportApipost],
  ["apipost-directory", exportApipostDirectory],
])
  test(`${format} preserves all seven attribute types and references across two serialized generations`, () => {
    const source = attributeDocument(),
      project = blankAttributeProject("source");
    importIntoProject(project, source);
    const before = structuredClone(project),
      expected = attributeSemantics(project);
    let current = project;
    for (let i = 0; i < 2; i++) {
      const output = JSON.parse(JSON.stringify(encode(current))),
        emitted = emittedAttributes(output, format);
      assert.equal(emitted.fields.length, 9);
      assert.equal(new Set(emitted.fields.map((f) => f.attribute_id)).size, 9);
      assert.ok(
        emitted.fields.every((f) => f.project_id === emitted.projectId),
      );
      assert.deepEqual(
        emitted.fields.map((f) => f.field_type),
        [1, 2, 3, 4, 5, 6, 7, 1, 2],
      );
      assert.equal(emitted.fields[8].enable, -1);
      const ids = new Set(emitted.fields.map((f) => f.attribute_id));
      assert.ok(
        emitted.apis.every((a) =>
          Object.keys(a.attribute_info).every((id) => ids.has(id)),
        ),
      );
      const next = blankAttributeProject("target-" + i);
      importIntoProject(next, output);
      assert.deepEqual(attributeSemantics(next), expected);
      assert.equal(next.requests.length, 2);
      current = next;
    }
    assert.deepEqual(project, before);
  });
