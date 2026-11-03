import test from "node:test";
import assert from "node:assert/strict";
import { importIntoProject } from "../src/core.mjs";
import { exportApipost } from "../src/apipost-export.mjs";
import { exportApipostDirectory } from "../src/apipost-directory-export.mjs";
import {
  catalogueDocument,
  emittedCatalogue,
} from "./fixtures/apipost-codes.mjs";

const exporters = [
  ["apipost", exportApipost],
  ["apipost-directory", exportApipostDirectory],
];
const semantic = (rows) => rows.map(({ code, label }) => ({ code, label }));
const blank = (id) => ({
  version: 1,
  id,
  name: id,
  requests: [],
  environments: [{ id: "default", name: "Default", variables: {} }],
  plans: [],
  cases: [],
  protocols: [],
  runs: [],
  protocolRuns: [],
  history: [],
  dictionary: [],
  parameterDictionary: [],
  documents: [],
  settings: {},
});

for (const [format, encode] of exporters)
  test(`${format} pure entrypoint preserves code types through two JSON-serialized generations`, () => {
    const document = catalogueDocument("http://127.0.0.1:1/must-not-send"),
      sourceBefore = structuredClone(document);
    const project = blank("source-project");
    importIntoProject(project, document);
    const before = structuredClone(project),
      expected = semantic(project.settings.statusCodes);
    let current = project;
    for (let generation = 0; generation < 2; generation++) {
      const snapshot = structuredClone(current);
      const output = JSON.parse(JSON.stringify(encode(current)));
      const emitted = emittedCatalogue(output, format);
      assert.deepEqual(
        emitted.rows,
        expected.map(({ code, label }) => ({
          code_number: code,
          code_msg: label,
        })),
      );
      const next = blank("target-" + generation);
      importIntoProject(next, output);
      assert.deepEqual(semantic(next.settings.statusCodes), expected);
      assert.equal(next.requests.length, 1);
      assert.equal(next.requests[0].url, document.apis[0].url);
      assert.ok(
        next.settings.statusCodes.every(
          (row) =>
            row.httpHint !== true && !Object.hasOwn(row, "apipostSource"),
        ),
      );
      assert.deepEqual(current, snapshot);
      current = next;
    }
    assert.deepEqual(project, before);
    assert.deepEqual(document, sourceBefore);
  });
