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

test("both native formats reject unsupported stored code state without returning partial data or mutating history", () => {
  const original = blank("invalid-project");
  original.settings.statusCodes = [
    {
      code: 409,
      label: "Conflict",
      apipostSource: { projectId: "old", codeId: "origin" },
    },
  ];
  original.history = [{ id: "history", detail: "unchanged" }];
  for (const change of [
    (p) => {
      p.settings.statusCodes[0].unknown = true;
    },
    (p) => {
      p.settings.statusCodes[0].apipostSource.unknown = true;
    },
    (p) => {
      p.settings.statusCodes[0].apipostSource.projectId = null;
    },
    (p) => {
      p.settings.statusCodes[0].httpHint = true;
    },
    (p) => {
      p.settings.statusCodes[0].code = -0;
    },
    (p) => {
      p.settings.statusCodes.push({ code: "409", label: "Conflict" });
    },
  ]) {
    const project = structuredClone(original);
    change(project);
    const before = structuredClone(project);
    for (const [, encode] of exporters) assert.throws(() => encode(project));
    assert.deepEqual(project, before);
  }
});

test("both native format entrypoints reject code accessors before invocation", () => {
  for (const position of ["settings", "array", "row", "origin"])
    for (const [, encode] of exporters) {
      const project = blank("getter-project");
      project.settings.statusCodes = [
        { code: "x", label: "value", apipostSource: { projectId: "old" } },
      ];
      const rows = project.settings.statusCodes;
      let calls = 0;
      const descriptor = {
        enumerable: true,
        get() {
          calls++;
          return "value";
        },
      };
      if (position === "settings")
        Object.defineProperty(project.settings, "statusCodes", descriptor);
      if (position === "array") Object.defineProperty(rows, "0", descriptor);
      if (position === "row")
        Object.defineProperty(rows[0], "label", descriptor);
      if (position === "origin")
        Object.defineProperty(rows[0].apipostSource, "projectId", descriptor);
      assert.throws(() => encode(project));
      assert.equal(calls, 0, position);
    }
});

test("native outputs retain the four-MiB guard without applying the unrelated one-MiB bulk-text limit", () => {
  const project = blank("large-catalogue");
  project.settings.statusCodes = Array.from({ length: 2000 }, (_, index) => ({
    code: `c${index}`,
    label: "v".repeat(600),
  }));
  for (const [format, encode] of exporters) {
    const output = JSON.parse(JSON.stringify(encode(project)));
    const rows = emittedCatalogue(output, format).rows;
    assert.equal(rows.length, 2000);
    assert.ok(Buffer.byteLength(JSON.stringify(rows)) > 1024 * 1024);
  }
  project.settings.statusCodes = project.settings.statusCodes.map((row) => ({
    ...row,
    label: "界".repeat(2000),
  }));
  const before = structuredClone(project);
  for (const [, encode] of exporters)
    assert.throws(() => encode(project), /4MiB/);
  assert.deepEqual(project, before);
});
