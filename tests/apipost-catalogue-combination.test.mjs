import test from "node:test";
import assert from "node:assert/strict";
import { importIntoProject } from "../src/core.mjs";
import { exportApipost } from "../src/apipost-export.mjs";
import { exportApipostDirectory } from "../src/apipost-directory-export.mjs";
import {
  catalogueDocument as codeDocument,
  emittedCatalogue as emittedCodes,
} from "./fixtures/apipost-codes.mjs";
import {
  catalogueDocument as descriptionDocument,
  emittedCatalogue as emittedDescriptions,
} from "./fixtures/apipost-descriptions.mjs";

const exporters = [
  ["apipost", exportApipost],
  ["apipost-directory", exportApipostDirectory],
];
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
const codeMeaning = (rows) => rows.map(({ code, label }) => ({ code, label }));
const descriptionMeaning = (rows) =>
  rows.map(({ key, description }) => ({ key, description }));

function combined() {
  const url = "http://127.0.0.1:1/must-not-send";
  const document = codeDocument(url);
  document.global.describe_library = descriptionDocument(
    url,
  ).global.describe_library.map((row) => ({
    ...row,
    ...(row.project_id === undefined
      ? {}
      : { project_id: document.project_id }),
  }));
  document.global.describe_library.push({
    key: "0007",
    description: "Parameter meaning is independent of the business code.",
  });
  const project = blank("combined-source");
  importIntoProject(project, document);
  return { project, document };
}

for (const [format, encode] of exporters)
  test(`${format} combines independent code and description identities through two serialized generations`, () => {
    const { project, document } = combined();
    project.settings.statusCodes[1].httpHint = false;
    const sourceBefore = structuredClone(project);
    const documentBefore = structuredClone(document);
    const codes = codeMeaning(project.settings.statusCodes);
    const descriptions = descriptionMeaning(
      project.settings.parameterDescriptions,
    );
    let current = project;
    for (let generation = 0; generation < 2; generation++) {
      const before = structuredClone(current);
      const output = JSON.parse(JSON.stringify(encode(current)));
      const actualCodes = emittedCodes(output, format);
      const actualDescriptions = emittedDescriptions(output, format);
      assert.deepEqual(
        actualCodes.rows,
        codes.map(({ code, label }) => ({
          code_number: code,
          code_msg: label,
        })),
      );
      assert.deepEqual(
        descriptionMeaning(actualDescriptions.rows),
        descriptions,
      );
      assert.equal(actualCodes.projectId, actualDescriptions.projectId);
      assert.equal(
        new Set(actualDescriptions.rows.map((row) => row.id)).size,
        descriptions.length,
      );
      assert.ok(
        actualCodes.rows.every(
          (row) => Object.keys(row).sort().join(",") === "code_msg,code_number",
        ),
      );
      assert.ok(
        actualDescriptions.rows.every(
          (row) => row.project_id === actualDescriptions.projectId,
        ),
      );
      const target = blank(`target-${generation}`);
      importIntoProject(target, output);
      assert.deepEqual(codeMeaning(target.settings.statusCodes), codes);
      assert.deepEqual(
        descriptionMeaning(target.settings.parameterDescriptions),
        descriptions,
      );
      assert.ok(
        target.settings.statusCodes.every(
          (row) =>
            !Object.hasOwn(row, "apipostSource") && row.httpHint !== true,
        ),
      );
      assert.ok(
        target.settings.parameterDescriptions.every(
          (row) => row.apipostSource.projectId === actualDescriptions.projectId,
        ),
      );
      assert.equal(
        Object.hasOwn(target.settings, "is_describe_library"),
        false,
      );
      assert.equal(target.requests.length, 1);
      assert.equal(target.requests[0].url, document.apis[0].url);
      assert.deepEqual(current, before);
      current = target;
    }
    assert.deepEqual(project, sourceBefore);
    assert.deepEqual(document, documentBefore);
    assert.deepEqual(project.settings.statusCodes[0].apipostSource, {
      projectId: document.project_id,
      codeId: "old-code",
    });
    assert.deepEqual(project.settings.parameterDescriptions[0].apipostSource, {
      projectId: document.project_id,
      id: "old-description",
    });
  });

test("an invalid code or description library rejects the whole native output without changing either source", () => {
  for (const mutate of [
    (p) => {
      p.settings.statusCodes[0].unknown = true;
    },
    (p) => {
      p.settings.statusCodes[1].httpHint = true;
    },
    (p) => {
      p.settings.statusCodes[0].apipostSource.unknown = true;
    },
    (p) => {
      p.settings.parameterDescriptions[0].unknown = true;
    },
    (p) => {
      p.settings.parameterDescriptions[0].apipostSource.unknown = true;
    },
    (p) => {
      p.settings.parameterDescriptions[0].description = "x".repeat(8001);
    },
  ]) {
    const { project } = combined();
    project.history = [{ id: "preserve-history" }];
    mutate(project);
    const before = structuredClone(project);
    for (const [, encode] of exporters) assert.throws(() => encode(project));
    assert.deepEqual(project, before);
  }
});

test("the description one-MiB budget stays separate from valid larger code catalogues", () => {
  const { project } = combined();
  project.settings.statusCodes = Array.from({ length: 2000 }, (_, i) => ({
    code: `c${i}`,
    label: "v".repeat(600),
  }));
  const before = structuredClone(project);
  for (const [format, encode] of exporters) {
    const output = JSON.parse(JSON.stringify(encode(project)));
    assert.ok(
      Buffer.byteLength(JSON.stringify(emittedCodes(output, format).rows)) >
        1024 * 1024,
    );
    const target = blank("large-target");
    importIntoProject(target, output);
    assert.deepEqual(
      codeMeaning(target.settings.statusCodes),
      codeMeaning(project.settings.statusCodes),
    );
    assert.deepEqual(
      descriptionMeaning(target.settings.parameterDescriptions),
      descriptionMeaning(project.settings.parameterDescriptions),
    );
  }
  assert.deepEqual(project, before);
  project.settings.parameterDescriptions = Array.from(
    { length: 2000 },
    (_, i) => ({ key: `k${i}`, description: "d".repeat(600) }),
  );
  const invalidBefore = structuredClone(project);
  for (const [, encode] of exporters)
    assert.throws(() => encode(project), /1\s?MiB/);
  assert.deepEqual(project, invalidBefore);
});
