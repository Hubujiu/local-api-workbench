import test from "node:test";
import assert from "node:assert/strict";
import { importIntoProject } from "../src/core.mjs";
import { exportApipost } from "../src/apipost-export.mjs";
import { exportApipostDirectory } from "../src/apipost-directory-export.mjs";
import {
  catalogueDocument,
  emittedCatalogue,
} from "./fixtures/apipost-descriptions.mjs";

const exporters = [
  ["apipost", exportApipost],
  ["apipost-directory", exportApipostDirectory],
];
const semantic = (rows) =>
  rows.map(({ key, description }) => ({ key, description }));
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
  test(`${format} pure entrypoint preserves the exact owner fixture through two generations`, () => {
    const document = catalogueDocument("http://127.0.0.1:1/must-not-send"),
      sourceBefore = structuredClone(document);
    const project = blank("source-project");
    importIntoProject(project, document);
    const before = structuredClone(project),
      expected = semantic(project.settings.parameterDescriptions);
    let current = project;
    for (let generation = 0; generation < 2; generation++) {
      const snapshot = structuredClone(current);
      const output = encode(current);
      const emitted = emittedCatalogue(output, format);
      assert.deepEqual(semantic(emitted.rows), expected);
      assert.equal(
        new Set(emitted.rows.map((entry) => entry.id)).size,
        expected.length,
      );
      for (const row of emitted.rows)
        assert.equal(row.project_id, emitted.projectId);
      const next = blank("target-" + generation);
      importIntoProject(next, output);
      assert.deepEqual(semantic(next.settings.parameterDescriptions), expected);
      assert.equal(next.requests.length, 1);
      assert.equal(next.requests[0].url, document.apis[0].url);
      assert.equal(Object.hasOwn(next.settings, "is_describe_library"), false);
      assert.deepEqual(current, snapshot);
      current = next;
    }
    assert.deepEqual(project, before);
    assert.deepEqual(document, sourceBefore);
  });

test("both public export entrypoints reject unknown or oversized descriptions without changing project state", () => {
  const source = blank("invalid-project");
  source.settings.parameterDescriptions = [
    {
      key: "key",
      description: "text",
      apipostSource: { projectId: "source", id: "source-id" },
    },
  ];
  source.history = [{ id: "historical-evidence", detail: "unchanged" }];
  for (const change of [
    (p) => {
      p.settings.parameterDescriptions[0].unknown = true;
    },
    (p) => {
      p.settings.parameterDescriptions[0].apipostSource.extra = true;
    },
    (p) => {
      p.settings.parameterDescriptions[0].description = "d".repeat(8001);
    },
    (p) => {
      p.settings.parameterDescriptions.push(
        structuredClone(p.settings.parameterDescriptions[0]),
      );
    },
    (p) => {
      p.settings.is_describe_library = true;
    },
  ]) {
    const project = structuredClone(source);
    change(project);
    const before = structuredClone(project);
    for (const [, encode] of exporters) assert.throws(() => encode(project));
    assert.deepEqual(project, before);
  }
});

test("both public export entrypoints reject catalogue accessors without invocation", () => {
  for (const location of ["settings", "array", "row", "origin"])
    for (const [, encode] of exporters) {
      const project = blank("getter-project");
      project.settings.parameterDescriptions = [
        {
          key: "key",
          description: "text",
          apipostSource: { projectId: "source" },
        },
      ];
      let calls = 0;
      const descriptor = {
        enumerable: true,
        get() {
          calls++;
          return "forbidden";
        },
      };
      if (location === "settings")
        Object.defineProperty(
          project.settings,
          "parameterDescriptions",
          descriptor,
        );
      if (location === "array")
        Object.defineProperty(
          project.settings.parameterDescriptions,
          "0",
          descriptor,
        );
      if (location === "row")
        Object.defineProperty(
          project.settings.parameterDescriptions[0],
          "description",
          descriptor,
        );
      if (location === "origin")
        Object.defineProperty(
          project.settings.parameterDescriptions[0].apipostSource,
          "id",
          descriptor,
        );
      assert.throws(() => encode(project));
      assert.equal(calls, 0);
    }
});
